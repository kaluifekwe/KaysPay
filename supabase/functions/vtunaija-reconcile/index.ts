import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { adminClient, verifyCronSecret, withJobLock } from "../_shared/auth.ts";
import { confirmServiceRefund } from "../_shared/service-refund.ts";
import { hasSeparatedFailureConfirmation } from "../_shared/provider-failure-confirmation.ts";
import {
  normalizeVTUNaijaQueryResult,
  queryVTUNaijaTransaction,
  isVtuNaijaConfigured,
  type NormalizedVTUNaijaQueryResult,
  type VTUNaijaOutcome,
} from "../_shared/vtunaija-client.ts";

// How long an order may sit unresolved before it is raised for a human
// refund decision. Originally justified by "VTUnaija documents no async
// processing state" -- that premise turned out to be wrong (their own
// webhook docs list transaction.processing as a real event, confirmed
// 2026-09-08), but the threshold itself still holds on its own merits: VTU
// services are normally near-instant, so a day unresolved is worth a human
// look regardless of whether "processing" is expected to eventually clear.
const STALE_ESCALATION_MS = 24 * 60 * 60 * 1000;

const VTUNAIJA_WEBHOOK_SECRET = Deno.env.get("VTUNAIJA_WEBHOOK_SECRET");
const WEBHOOK_MAX_BODY_BYTES = 65536;

// Resolves VTUnaija airtime/data/bill (electricity+TV)/exam_pin (WAEC/NECO/
// NABTEB result-checking only) orders left 'pending' after vtu-purchase's
// inline attempt hit an ambiguous outcome (network blip / unrecognized
// response shape). Only ever transitions 'pending' -> 'completed'/'refunded'
// based on VTUnaija's own answer — never guesses, and never touches a
// transaction whose provider isn't 'vtunaija'.
//
// Two independent paths feed the same resolution logic (applyVtunaijaOutcome
// below):
//   1. The cron sweep (POST + x-cron-secret) — polls transactionquery/
//      index.php, confirmed via VTUnaija's docs 2026-09-06: one endpoint
//      covers every service type, keyed by the same `request-id` value WE
//      submitted at purchase time (idempotency_key).
//   2. The webhook receiver (POST + x-webhook-signature, no cron secret) —
//      VTUnaija pushes the answer to us instead of us polling for it, added
//      2026-09-08 once their webhook docs were found. `transaction_id` in
//      the webhook payload is documented as "the same transaction/request
//      identifier you sent in your original purchase request" — i.e. the
//      same idempotency_key the sweep already keys off.
// The sweep remains the safety net for anything the webhook never delivers
// (dropped delivery, secret not yet configured, etc.) — this does not
// replace it, only makes most orders resolve immediately instead of on the
// next sweep tick.

type TxRow = { id: string; type: string; created_at: string; metadata: Record<string, unknown> | null };

/**
 * The single place that decides what happens for a resolved VTUnaija
 * outcome. Shared by the sweep and the webhook so a transaction gets
 * identical safety guarantees (two-step failure confirmation before
 * refunding, escalation alerts, never guessing on "unknown") no matter
 * which path resolved it.
 */
async function applyVtunaijaOutcome(
  supabase: ReturnType<typeof adminClient>,
  tx: TxRow,
  normalized: NormalizedVTUNaijaQueryResult,
  extraMetadata: Record<string, unknown> = {},
): Promise<{ result: "completed" | "refunded" | "unresolved"; escalated: boolean }> {
  if (normalized.outcome === "success") {
    await supabase.rpc("complete_service_transaction", {
      p_tx_id: tx.id,
      p_order_id: normalized.transactionId,
    });
    return { result: "completed", escalated: false };
  }

  if (normalized.outcome === "failed") {
    if (hasSeparatedFailureConfirmation((tx.metadata as any)?.provider_failure_confirmation, "failed")) {
      await confirmServiceRefund(supabase, tx.id, normalized.message || "reconcile_refund", "reconcile");
      return { result: "refunded", escalated: false };
    }
    const checkedAt = new Date().toISOString();
    await supabase.from("transactions").update({ metadata: {
      ...tx.metadata,
      ...extraMetadata,
      provider_failure_confirmation: {
        at: checkedAt,
        status: "failed",
        message: normalized.message.slice(0, 200),
      },
      last_reconcile_check: { at: checkedAt, outcome: "failed_unconfirmed" },
    } }).eq("id", tx.id).eq("status", "pending");
    return { result: "unresolved", escalated: false };
  }

  if (normalized.outcome === "processing") {
    // A real, documented in-flight state — the provider is actively telling
    // us this order isn't resolved yet, which reads very differently to a
    // human than "unknown" (we have no idea what this order even is). Never
    // refund on it; just record it and let the next check re-evaluate.
    const checkedAt = new Date().toISOString();
    await supabase.from("transactions").update({ metadata: {
      ...tx.metadata,
      ...extraMetadata,
      provider_failure_confirmation: null,
      last_reconcile_check: {
        at: checkedAt,
        outcome: "processing",
        provider_message: (normalized.message || "(provider returned no message)").slice(0, 200),
      },
    } }).eq("id", tx.id).eq("status", "pending");

    const ageMs = Date.now() - new Date(tx.created_at).getTime();
    if (ageMs > STALE_ESCALATION_MS) {
      await supabase.rpc("record_monitoring_alert", {
        p_fingerprint: `vtu_stuck_processing_${tx.id}`,
        p_type: "vtu_stuck_unresolved",
        p_severity: "warning",
        p_details: {
          transaction_id: tx.id,
          type: tx.type,
          age_hours: Math.floor(ageMs / 3_600_000),
          provider_message: (normalized.message || "").slice(0, 200),
          note: "Provider still reports this as processing after 24h+. Customer was debited before the provider call.",
        },
      });
      return { result: "unresolved", escalated: true };
    }
    return { result: "unresolved", escalated: false };
  }

  // "unknown" means the response didn't match any recognized vocabulary at
  // all (query failed, order not found, malformed shape) — never safe to
  // refund on its own, so record what the provider actually said so every
  // stuck order doesn't look identical and nobody can decide. This is a
  // note for humans; nothing here refunds on it.
  const checkedAt = new Date().toISOString();
  await supabase.from("transactions").update({ metadata: {
    ...tx.metadata,
    ...extraMetadata,
    provider_failure_confirmation: null,
    last_reconcile_check: {
      at: checkedAt,
      outcome: "unknown",
      provider_message: (normalized.message || "(provider returned no message)").slice(0, 200),
    },
  } }).eq("id", tx.id).eq("status", "pending");

  const ageMs = Date.now() - new Date(tx.created_at).getTime();
  if (ageMs > STALE_ESCALATION_MS) {
    await supabase.rpc("record_monitoring_alert", {
      p_fingerprint: `vtu_stuck_unknown_${tx.id}`,
      p_type: "vtu_stuck_unresolved",
      p_severity: "warning",
      p_details: {
        transaction_id: tx.id,
        type: tx.type,
        age_hours: Math.floor(ageMs / 3_600_000),
        provider_message: (normalized.message || "").slice(0, 200),
        note: "Customer was debited before the provider call. Needs a refund decision.",
      },
    });
    return { result: "unresolved", escalated: true };
  }
  return { result: "unresolved", escalated: false };
}

/** VTUnaija's webhook status vocabulary -> our own outcome vocabulary. */
function mapWebhookStatusToOutcome(status: string): VTUNaijaOutcome {
  const s = status.trim().toLowerCase();
  if (s === "successful") return "success";
  if (s === "processing") return "processing";
  // "refunded" means VTUnaija reversed the charge on their own side -- the
  // service was never delivered, so treat it exactly like "failed" and let
  // our own confirmServiceRefund flow run for the customer.
  if (s === "failed" || s === "refunded") return "failed";
  return "unknown";
}

// Confirmed via VTUnaija's webhook documentation, 2026-09-08:
// X-Webhook-Signature = hash_hmac('sha256', `${timestamp}.${rawBody}`, secret)
// PHP's hash_hmac (without the raw flag) outputs lowercase hex, not base64.
async function isValidVtunaijaSignature(timestamp: string | null, rawBody: string, signature: string | null): Promise<boolean> {
  if (!timestamp || !signature || !VTUNAIJA_WEBHOOK_SECRET) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(VTUNAIJA_WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${rawBody}`));
  const hex = Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, "0")).join("");
  if (hex.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

async function handleWebhook(req: Request): Promise<Response> {
  const declaredLength = Number(req.headers.get("content-length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > WEBHOOK_MAX_BODY_BYTES) {
    return new Response(JSON.stringify({ error: "Payload too large" }), { status: 413 });
  }
  const rawBody = await req.text();
  if (new TextEncoder().encode(rawBody).byteLength > WEBHOOK_MAX_BODY_BYTES) {
    return new Response(JSON.stringify({ error: "Payload too large" }), { status: 413 });
  }

  const valid = await isValidVtunaijaSignature(
    req.headers.get("x-webhook-timestamp"),
    rawBody,
    req.headers.get("x-webhook-signature"),
  );
  if (!valid) {
    return new Response(JSON.stringify({ error: "Invalid signature" }), { status: 401 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response(JSON.stringify({ error: "Invalid payload" }), { status: 400 });
  }

  // Documented as "the same transaction/request identifier that you sent in
  // your original purchase request" -- i.e. our own idempotency_key, the
  // exact same value the polling sweep above keys off.
  const queryId = String(payload.transaction_id || "");
  const eventId = String(payload.event_id || "") || null;
  // Always 200 + the exact acknowledgement body VTUnaija's docs specify,
  // even when there's nothing for us to do -- an error here would just
  // trigger pointless retries for a transaction we've already resolved (or
  // never recognize), and we never want to leak internal state to a webhook
  // caller regardless of provenance.
  const ack = () => new Response(JSON.stringify({ status: "success" }), { status: 200 });
  if (!queryId) return ack();

  const supabase = adminClient();
  const { data: tx } = await supabase
    .from("transactions")
    .select("id, type, created_at, metadata")
    .eq("status", "pending")
    .eq("metadata->>provider", "vtunaija")
    .eq("metadata->>idempotency_key", queryId)
    .maybeSingle();
  if (!tx) return ack();

  // A retried delivery of the SAME event must never be treated as a second,
  // independent failure confirmation (see hasSeparatedFailureConfirmation) --
  // it's the same report resent, not new evidence.
  if (eventId && (tx.metadata as any)?.last_webhook_event_id === eventId) return ack();

  const normalized: NormalizedVTUNaijaQueryResult = {
    outcome: mapWebhookStatusToOutcome(String(payload.status || "")),
    transactionId: payload.provider_reference ? String(payload.provider_reference) : null,
    transactionType: payload.service ? String(payload.service) : null,
    size: payload.data_type ? String(payload.data_type) : null,
    network: payload.network ? String(payload.network) : null,
    message: String(payload.api_response || ""),
  };

  await applyVtunaijaOutcome(supabase, tx as TxRow, normalized, eventId ? { last_webhook_event_id: eventId } : {});
  return ack();
}

serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  // VTUnaija's webhook deliveries carry their own HMAC signature and no
  // Supabase JWT/cron secret; distinguish by that header's presence rather
  // than a URL/query param, since their dashboard just takes a plain POST
  // URL with no room for us to add our own routing decoration.
  if (req.headers.get("x-webhook-signature")) {
    return handleWebhook(req);
  }

  if (!verifyCronSecret(req)) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  if (!isVtuNaijaConfigured()) {
    return new Response(JSON.stringify({ checked: 0, reason: "VTUnaija not configured" }), { status: 200 });
  }

  const supabase = adminClient();

  const result = await withJobLock(supabase, "vtunaija-reconcile", async () => {
    // There used to be a 48-hour floor here (gte created_at, cutoff). Past
    // that an order was simply never looked at again — the customer had
    // already been debited by debit_for_service before the provider call, so
    // a silently dropped order is money taken for nothing, with no refund and
    // no alert. The same ceiling in crypto-buy-reconcile hid eight orders for
    // twelve days. Age is a reason to escalate, never a reason to stop
    // looking.
    const { data: pending, error } = await supabase
      .from("transactions")
      .select("id, type, created_at, metadata")
      .eq("status", "pending")
      .in("type", ["airtime", "data", "bill", "exam_pin"])
      .eq("metadata->>provider", "vtunaija")
      .not("metadata->>idempotency_key", "is", null)
      .order("created_at", { ascending: true })
      .limit(50);

    if (error) {
      return { checked: 0, error: error.message };
    }

    let completed = 0;
    let refunded = 0;
    let stillPending = 0;
    let escalated = 0;

    for (const tx of pending || []) {
      // The query endpoint is keyed by our own request-id (idempotency_key),
      // not provider_transaction_id — see the confirmed docs note above.
      const queryId = (tx.metadata as any)?.idempotency_key;
      if (!queryId) continue;

      try {
        const queried = await queryVTUNaijaTransaction(queryId);
        const normalized = normalizeVTUNaijaQueryResult(queried);
        const { result: action, escalated: wasEscalated } = await applyVtunaijaOutcome(supabase, tx as TxRow, normalized);
        if (action === "completed") completed++;
        else if (action === "refunded") refunded++;
        else stillPending++;
        if (wasEscalated) escalated++;
      } catch {
        stillPending++; // network hiccup this round — next sweep retries
      }
    }

    return { checked: pending?.length ?? 0, completed, refunded, stillPending, escalated };
  });

  return new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json" } });
});
