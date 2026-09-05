import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

/**
 * Best-effort notifications for a customer-initiated Swap (migration 212).
 * Delivered via the `notifications` table (migration 050) and the
 * notifications-push cron (migration 051) -- never allowed to fail the
 * settlement itself.
 */
export async function notifyCryptoSwapCompleted(
  supabase: SupabaseClient,
  params: { userId: string; fromAsset: string; toAsset: string; fromAmount: number; toAmount: number },
): Promise<void> {
  const fromDisplay = String(Math.round(params.fromAmount * 1_000_000) / 1_000_000);
  const toDisplay = String(Math.round(params.toAmount * 1_000_000) / 1_000_000);
  const { error } = await supabase.from("notifications").insert({
    user_id: params.userId,
    title: "Swap complete",
    body: `Swapped ${fromDisplay} ${params.fromAsset} for ${toDisplay} ${params.toAsset}. It's in your KaysPay Wallet.`,
    type: "transaction",
    data: { kind: "crypto_swap_completed", from_asset: params.fromAsset, to_asset: params.toAsset },
  });
  if (error) console.error("notifyCryptoSwapCompleted: insert failed:", error.message);
}

export async function notifyCryptoSwapFailed(
  supabase: SupabaseClient,
  params: { userId: string; fromAsset: string; toAsset: string },
): Promise<void> {
  const { error } = await supabase.from("notifications").insert({
    user_id: params.userId,
    title: "Swap didn't go through",
    body: `Your swap from ${params.fromAsset} to ${params.toAsset} could not be completed. Your ${params.fromAsset} is safe in your wallet. Please try again.`,
    type: "transaction",
    data: { kind: "crypto_swap_failed", from_asset: params.fromAsset, to_asset: params.toAsset },
  });
  if (error) console.error("notifyCryptoSwapFailed: insert failed:", error.message);
}
