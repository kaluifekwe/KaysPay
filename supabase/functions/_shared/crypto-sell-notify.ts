import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

/**
 * Sent when Sell's swap leg (source coin -> USDT) fails ASYNCHRONOUSLY --
 * confirmSwapQuotation itself didn't throw, but Quidax's own
 * swap_transaction.failed webhook arrived later. Nothing was lost: the
 * source coin never actually left the customer's sub-account (see
 * fail_crypto_sell_swap_pending, migration 211), so this reassures rather
 * than escalates -- same tone as notifyCryptoSwapFailed.
 */
export async function notifyCryptoSellSwapFailed(
  supabase: SupabaseClient,
  params: { userId: string; asset: string },
): Promise<void> {
  const { error } = await supabase.from("notifications").insert({
    user_id: params.userId,
    title: "Sale didn't go through",
    body: `Your sale of ${params.asset} could not be completed. Your ${params.asset} is safe in your wallet. Please try again.`,
    type: "transaction",
    data: { kind: "crypto_sell_swap_failed", asset: params.asset },
  });
  if (error) console.error("notifyCryptoSellSwapFailed: insert failed:", error.message);
}
