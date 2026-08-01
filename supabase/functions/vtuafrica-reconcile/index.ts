import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { adminClient, verifyCronSecret, withJobLock } from "../_shared/auth.ts";
import { redactSecrets } from "../_shared/redact.ts";
import {
  queryVTUAfrica,
  isVtuAfricaConfigured,
  normalizeVTUAfricaResult,
  vtuAfricaOutcome,
} from "../_shared/vtuafrica-client.ts";

// Scheduled sweep (see migration 028) that settles VTUAfrica orders left
// 'pending' by vtu-purchase — the async case (e.g. betting "Processing")
// where the request was accepted + our merchant wallet charged, but the
// order hadn't finalized yet. Mirrors vtu-reconcile (VTU.ng), but queries
// VTUAfrica's transaction endpoint by our own ref (stripped of non-
// alphanumerics, which is how VTUAfrica stores it).
//
// Safety: only COMPLETE on an explicit "Completed" and only REFUND on an
// explicit failure status word. Anything ambiguous ("Does not Exist", an
// unrecognized status, a network blip, or a VTU.ng order this sweep can't
// recognize) is LEFT pending — never wrongly refunded or double-settled.
// Old orders remain eligible: abandoning them after 48h left customer money
// permanently pending. Financial monitoring separately alerts operators.

serve(async (req: Request) => {
  if (!verifyCronSecret(req)) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  if (!isVtuAfricaConfigured()) {
    return new Response(JSON.stringify({ checked: 0, reason: "VTUAfrica not configured" }), { status: 200 });
  }

  const supabase = adminClient();

  const result = await withJobLock(supabase, "vtuafrica-reconcile", async () => {
    const { data: pending, error } = await supabase
      .from("transactions")
      .select("id, metadata")
      .eq("status", "pending")
      .in("type", ["airtime", "data", "bill", "exam_pin"])
      .or("metadata->>provider.eq.vtuafrica,metadata->>provider.is.null")
      .not("metadata->>idempotency_key", "is", null)
      .order("created_at", { ascending: true })
      .limit(15);

    if (error) {
      return { checked: 0, error: error.message };
    }

    let completed = 0;
    let refunded = 0;
    let stillPending = 0;

    for (const tx of pending || []) {
      if (tx.metadata?.provider && tx.metadata.provider !== "vtuafrica") continue;
      const ref = tx.metadata?.idempotency_key;
      if (!ref) continue;

      try {
        // The cron repeats every 30 seconds, so one bounded attempt per order
        // is preferable to five nested retries that can monopolize the sweep.
        const vtuResult = await queryVTUAfrica(ref, 1, 7000);
        const outcome = vtuAfricaOutcome(vtuResult);
        const normalized = normalizeVTUAfricaResult(vtuResult);

        if (outcome === "success") {
          const { error: completeError } = await supabase.rpc("complete_service_transaction", {
            p_tx_id: tx.id,
            p_order_id: normalized.reference,
          });
          if (completeError) stillPending++;
          else completed++;
        } else if (outcome === "failed") {
          const previous = tx.metadata?.provider_failure_confirmation;
          const previousAt = previous?.at ? new Date(previous.at).getTime() : 0;
          const separatedConfirmations =
            previous?.status === normalized.status &&
            Number.isFinite(previousAt) &&
            Date.now() - previousAt >= 20_000;

          if (separatedConfirmations) {
            const { error: refundError } = await supabase.rpc("refund_service_transaction", {
              p_tx_id: tx.id,
              p_reason: normalized.status || "reconcile_refund",
            });
            if (refundError) stillPending++;
            else refunded++;
          } else {
            await supabase
              .from("transactions")
              .update({
                metadata: {
                  ...tx.metadata,
                  provider_failure_confirmation: {
                    at: new Date().toISOString(),
                    status: normalized.status,
                    message: normalized.message,
                  },
                },
              })
              .eq("id", tx.id)
              .eq("status", "pending");
            stillPending++;
          }
        } else {
          // "Processing" / "Does not Exist" / unknown / wrong-provider — leave it.
          // Record the raw provider answer on the transaction itself (not a
          // temporary debug deploy) so any order stuck across many sweeps can
          // be inspected directly with a normal read — added 2026-07-06 after
          // repeatedly having to redeploy a throwaway diagnostic to see why a
          // specific 1xbet order never resolved.
          await supabase
            .from("transactions")
            .update({ metadata: { ...tx.metadata, last_reconcile_check: { at: new Date().toISOString(), vtuResult } } })
            .eq("id", tx.id);
          stillPending++;
        }
      } catch (e) {
        // Keep the raw provider/network error OUT of transaction metadata (users
        // can read their own rows via RLS). Store only a generic status; the
        // redacted detail goes to the server logs for debugging.
        console.error("vtuafrica-reconcile verify failed for tx", tx.id, ":", redactSecrets(e));
        await supabase
          .from("transactions")
          .update({ metadata: { ...tx.metadata, last_reconcile_check: { at: new Date().toISOString(), status: "verify_failed" } } })
          .eq("id", tx.id);
        stillPending++; // network hiccup this round; the next scheduled sweep retries.
      }
    }

    return { checked: pending?.length ?? 0, completed, refunded, stillPending };
  });

  return new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json" } });
});
