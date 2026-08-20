import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { adminClient, verifyCronSecret, withJobLock } from "../_shared/auth.ts";
import { getSwapTransaction, isQuidaxConfigured, QuidaxError } from "../_shared/quidax-client.ts";

// Safety net for a swap_transaction.complete/.failed webhook that never
// arrives for a Sell — the same gap crypto-buy-reconcile closed for Buy.
// Found the hard way: a real sale converted USDT -> NGN successfully on
// Quidax's side, but the settlement webhook was rejected by our own
// signature check (a misconfigured QUIDAX_WEBHOOK_SECRET), leaving the
// customer's proceeds sitting uncredited and the transaction stuck
// 'pending' with no automatic recovery path.
//
// crypto-sell confirms the swap synchronously before this row is ever
// created 'pending' (see record_crypto_sell_pending), so by the time a row
// is old enough to sweep, the swap itself has already resolved on Quidax's
// side one way or another — a short floor is appropriate here, unlike
// Buy's 30-minute one (which waits on a customer's bank transfer).
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

serve(async (req: Request) => {
  if (!verifyCronSecret(req)) return json({ error: "Unauthorized" }, 401);
  if (!isQuidaxConfigured()) {
    return json({ checked: 0, reason: "Quidax not configured" });
  }

  const supabase = adminClient();

  const result = await withJobLock(supabase, "crypto-sell-reconcile", async () => {
    const floor = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

    const { data: stuck, error } = await supabase
      .from("transactions")
      .select("id, user_id, metadata")
      .eq("status", "pending")
      .eq("type", "crypto_sell")
      .lte("created_at", floor)
      .gte("created_at", cutoff)
      .limit(50);

    if (error) return { checked: 0, error: error.message };

    let completed = 0, failed = 0, stillPending = 0, skipped = 0;

    for (const tx of stuck || []) {
      const meta = (tx.metadata as any) || {};
      const swapId = String(meta.quidax_swap_id || "");
      if (!swapId) { skipped++; continue; }

      const { data: account } = await supabase
        .from("crypto_accounts")
        .select("quidax_user_id")
        .eq("user_id", tx.user_id)
        .maybeSingle();
      if (!account) { skipped++; continue; }

      try {
        const swap = await getSwapTransaction({ quidaxUserId: account.quidax_user_id, swapTransactionId: swapId });
        if (swap.status === "completed") {
          const received = Number(swap.receivedAmount);
          if (!Number.isFinite(received) || received <= 0) { skipped++; continue; }
          const { error: settleError } = await supabase.rpc("complete_crypto_sell", {
            p_swap_id: swapId,
            p_ngn_kobo: Math.round(received * 100),
          });
          if (settleError) {
            console.error(`crypto-sell-reconcile: complete_crypto_sell failed for ${swapId}:`, settleError.message);
            skipped++;
            continue;
          }
          completed++;
        } else if (swap.status === "failed") {
          await supabase.rpc("fail_crypto_sell", { p_swap_id: swapId, p_reason: "reconcile_failed" });
          failed++;
        } else {
          stillPending++;
        }
      } catch (e) {
        if (e instanceof QuidaxError) {
          console.error(`crypto-sell-reconcile: requery failed for swap ${swapId} (status ${e.status}):`, e.message);
        }
        skipped++;
      }
    }

    return { checked: stuck?.length ?? 0, completed, failed, stillPending, skipped };
  });

  return json(result);
});
