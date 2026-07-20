import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { adminClient, verifyCronSecret, withJobLock } from "../_shared/auth.ts";
import { callVTUNG, isVtuConfigured, NON_TERMINAL_STATUSES, SUCCESS_STATUSES } from "../_shared/vtu-client.ts";

// Scheduled sweep (via pg_cron, see migration 016) that resolves VTU.ng
// orders left 'pending' after vtu-purchase's short synchronous check gave
// up. VTU.ng's webhook does NOT fire for normal automated completions (only
// admin-forced completions and refunds — confirmed by testing), so this is
// the only reliable way stuck orders ever get finalized. Not user-triggered:
// runs globally across all pending VTU transactions, using our own stored
// idempotency_key as the request_id to requery.
//
// Only ever transitions 'pending' -> 'completed'/'refunded' based on VTU.ng's
// own reported status — never guesses, never touches non-VTU transactions
// (identified by having a metadata.idempotency_key, which only vtu-purchase sets).

serve(async (req: Request) => {
  if (!verifyCronSecret(req)) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  if (!isVtuConfigured()) {
    return new Response(JSON.stringify({ checked: 0, reason: "VTU not configured" }), { status: 200 });
  }

  const supabase = adminClient();

  const result = await withJobLock(supabase, "vtu-reconcile", async () => {
    // Only VTU-originated pending transactions (they carry an idempotency_key
    // in metadata; withdrawals/paystack funding use different tables/flows).
    // Cap the age at 48h — anything older is treated as permanently stuck and
    // left for manual review rather than requeried forever.
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const { data: pending, error } = await supabase
      .from("transactions")
      .select("id, metadata")
      .eq("status", "pending")
      .in("type", ["airtime", "data", "bill"])
      .not("metadata->>idempotency_key", "is", null)
      .gte("created_at", cutoff)
      .limit(50);

    if (error) {
      return { checked: 0, error: error.message };
    }

    let completed = 0;
    let refunded = 0;
    let stillPending = 0;

    for (const tx of pending || []) {
      const requestId = tx.metadata?.idempotency_key;
      if (!requestId) continue;

      try {
        const requery = await callVTUNG(supabase, "/requery", { request_id: requestId });
        if (requery?.code !== "success") continue; // couldn't get a real answer this round

        const status = requery.data?.status;

        if (SUCCESS_STATUSES.includes(status)) {
          await supabase.rpc("complete_service_transaction", {
            p_tx_id: tx.id,
            p_order_id: requery.data?.order_id ?? null,
          });
          completed++;
        } else if (!NON_TERMINAL_STATUSES.includes(status)) {
          // refunded / failed / cancelled / anything else terminal-but-not-success
          await supabase.rpc("refund_service_transaction", {
            p_tx_id: tx.id,
            p_reason: status || "reconcile_refund",
          });
          refunded++;
        } else {
          stillPending++;
        }
      } catch {
        stillPending++; // network hiccup this round — next sweep will retry
      }
    }

    return { checked: pending?.length ?? 0, completed, refunded, stillPending };
  });

  return new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json" } });
});
