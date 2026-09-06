import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { adminClient, verifyCronSecret, withJobLock } from "../_shared/auth.ts";
import { confirmServiceRefund } from "../_shared/service-refund.ts";
import { hasSeparatedFailureConfirmation } from "../_shared/provider-failure-confirmation.ts";
import {
  normalizeVTUNaijaQueryResult,
  queryVTUNaijaTransaction,
  isVtuNaijaConfigured,
} from "../_shared/vtunaija-client.ts";

// How long an order may sit unresolved by the provider before it is raised
// for a human refund decision. VTUnaija documents no async "processing" state
// for these services (see the note below), so anything still unresolved a day
// later is stuck, not slow.
const STALE_ESCALATION_MS = 24 * 60 * 60 * 1000;

// Scheduled sweep (see the VTUnaija migration cron) that resolves VTUnaija
// airtime/data/bill (electricity+TV)/exam_pin (WAEC/NECO/NABTEB result-
// checking only) orders left 'pending' after vtu-purchase's inline attempt
// hit an ambiguous outcome (network blip /
// unrecognized response shape — VTUnaija documents no async "processing"
// state for any of these, so this should only ever catch a genuine
// network-level ambiguity, not a normal async order). Only ever transitions
// 'pending' -> 'completed'/'refunded' based on VTUnaija's own query answer —
// never guesses, and never touches a transaction whose provider isn't
// 'vtunaija'.
//
// Query endpoint confirmed via VTUnaija's own documentation, 2026-09-06: one
// unified transactionquery/index.php covers every service type (airtime,
// data, bill, exam_pin), keyed by the same `request-id` value WE submitted
// at purchase time (idempotency_key) — see queryVTUNaijaTransaction's
// docstring. This replaces two previously separate, unconfirmed endpoint
// guesses that never matched the real API and produced unrecognizable
// ("ambiguous") responses — e.g. the two Kuriyetu Umar orders stuck with
// "VT ambiguous code" that prompted re-checking this against the real docs.

serve(async (req: Request) => {
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
      const queryId = tx.metadata?.idempotency_key;
      if (!queryId) continue;

      try {
        const queried = await queryVTUNaijaTransaction(queryId);
        const normalized = normalizeVTUNaijaQueryResult(queried);

        if (normalized.outcome === "success") {
          await supabase.rpc("complete_service_transaction", {
            p_tx_id: tx.id,
            p_order_id: normalized.transactionId,
          });
          completed++;
        } else if (normalized.outcome === "failed") {
          if (hasSeparatedFailureConfirmation(tx.metadata?.provider_failure_confirmation, "failed")) {
            await confirmServiceRefund(supabase, tx.id, normalized.message || "reconcile_refund", "reconcile");
            refunded++;
          } else {
            const checkedAt = new Date().toISOString();
            await supabase.from("transactions").update({ metadata: {
              ...tx.metadata,
              provider_failure_confirmation: {
                at: checkedAt,
                status: "failed",
                message: normalized.message.slice(0, 200),
              },
              last_reconcile_check: { at: checkedAt, outcome: "failed_unconfirmed" },
            } }).eq("id", tx.id).eq("status", "pending");
            stillPending++;
          }
        } else if (normalized.outcome === "processing") {
          // A real, documented in-flight state (see the confirmed-docs note
          // above) — the provider is actively telling us this order isn't
          // resolved yet, which reads very differently to a human than
          // "unknown" (we have no idea what this order even is). Never
          // refund on it; just record it and let the next sweep re-check.
          const checkedAt = new Date().toISOString();
          await supabase.from("transactions").update({ metadata: {
            ...tx.metadata,
            provider_failure_confirmation: null,
            last_reconcile_check: {
              at: checkedAt,
              outcome: "processing",
              provider_message: (normalized.message || "(provider returned no message)").slice(0, 200),
            },
          } }).eq("id", tx.id).eq("status", "pending");
          stillPending++;

          // VTU services are normally near-instant, so "processing" for over
          // a day is still worth a human look — just tagged distinctly from
          // the "unknown" alert below so the note reflects what's really
          // known (the provider confirms it's working, not that we're lost).
          const ageMs = Date.now() - new Date(tx.created_at as string).getTime();
          if (ageMs > STALE_ESCALATION_MS) {
            escalated++;
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
          }
        } else {
          // "unknown" means the response didn't match any recognized
          // vocabulary at all (query failed, order not found, malformed
          // shape) — never safe to refund on its own, so record what the
          // provider actually said without it every stuck order looks
          // identical and nobody can decide. This is a note for humans;
          // nothing here refunds on it.
          const checkedAt = new Date().toISOString();
          await supabase.from("transactions").update({ metadata: {
            ...tx.metadata,
            provider_failure_confirmation: null,
            last_reconcile_check: {
              at: checkedAt,
              outcome: "unknown",
              provider_message: (normalized.message || "(provider returned no message)").slice(0, 200),
            },
          } }).eq("id", tx.id).eq("status", "pending");
          stillPending++; // unknown/malformed query response — leave it, never guess

          // An order the provider has never resolved is not going to resolve
          // itself. Raise it once (record_monitoring_alert dedupes on
          // fingerprint) so a person decides the refund, rather than the
          // customer's money sitting pending forever unnoticed.
          const ageMs = Date.now() - new Date(tx.created_at as string).getTime();
          if (ageMs > STALE_ESCALATION_MS) {
            escalated++;
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
          }
        }
      } catch {
        stillPending++; // network hiccup this round — next sweep retries
      }
    }

    return { checked: pending?.length ?? 0, completed, refunded, stillPending, escalated };
  });

  return new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json" } });
});
