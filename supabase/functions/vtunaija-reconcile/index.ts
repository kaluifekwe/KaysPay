import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { adminClient, verifyCronSecret, withJobLock } from "../_shared/auth.ts";
import { confirmServiceRefund } from "../_shared/service-refund.ts";
import { hasSeparatedFailureConfirmation } from "../_shared/provider-failure-confirmation.ts";
import {
  normalizeVTUNaijaQueryResult,
  queryVTUNaijaTransaction,
  queryVTUNaijaDataTransaction,
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
// Query-endpoint pairing assumption (NOT yet confirmed with a live forced-
// timeout test): airtime -> queryTransaction (transaction_id), data ->
// queryDataTransaction (datarequest_id) — the naming ("datarequest_id" reads
// as "any data request", not implementation-specific to one data endpoint)
// suggests this pairing holds even though our data purchases go through
// /data/, not /internetbundles/. A wrong guess here is safe, not silently
// wrong: an unrecognized/error query response is classified "unknown" and
// stays pending for the next sweep — it can never cause a false
// complete/refund. Verify this pairing with a real forced-timeout test
// before relying on it at scale.

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
      const requestId = tx.metadata?.idempotency_key;
      const queryId = tx.metadata?.provider_transaction_id ?? requestId;
      if (!queryId) continue;

      try {
        const queried = tx.type === "data"
          ? await queryVTUNaijaDataTransaction(queryId)
          : await queryVTUNaijaTransaction(queryId);
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
        } else {
          // "unknown" covers two very different provider answers: the query
          // itself failed or the order is not found (it likely never landed),
          // versus the order genuinely still processing. Only the first is
          // safe to refund, so record what the provider actually said —
          // without it every stuck order looks identical and nobody can
          // decide. This is a note for humans; nothing here refunds on it.
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
