import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { confirmSwapQuotation, createSwapQuotation } from "./quidax-client.ts";
import { findSwapAsset } from "./crypto-assets.ts";

/**
 * Settles a Buy whose leg 1 (Ramp: NGN -> USDT into the customer's own
 * sub-account) has completed. Shared between crypto-ramp-webhook (the normal
 * path) and crypto-buy-reconcile (the safety net for a webhook that never
 * arrives) so the two-leg swap logic exists in exactly one place — this is
 * the trickiest part of Buy, and letting the webhook and the reconcile sweep
 * drift apart would be its own class of bug.
 *
 * For a straight USDT purchase, leg 1 IS the whole order. For any other
 * coin, this kicks off leg 2 (swap USDT -> target coin inside the same
 * sub-account); leg 2's own settlement runs through
 * swap_transaction.complete/.failed in crypto-quidax-webhook, same as
 * crypto-sell's swap in the other direction.
 */
export async function settleCryptoBuySuccess(
  supabase: SupabaseClient,
  params: {
    merchantReference: string;
    receivedUsdt: number;
    txHash: string | null;
    logPrefix: string;
  },
): Promise<void> {
  const { merchantReference, receivedUsdt, txHash, logPrefix } = params;

  const { data: order } = await supabase
    .from("transactions")
    .select("id, user_id, status, metadata")
    .eq("type", "crypto_buy")
    .eq("metadata->>quidax_merchant_reference", merchantReference)
    .maybeSingle();
  if (!order) {
    console.warn(`${logPrefix}: no buy found for ${merchantReference}`);
    return;
  }

  const targetAsset = String(order.metadata?.asset || "USDT").toUpperCase();
  const swapAsset = targetAsset === "USDT" ? null : findSwapAsset(targetAsset);

  if (!swapAsset) {
    const { error } = await supabase.rpc("complete_crypto_buy", {
      p_merchant_reference: merchantReference,
      p_crypto_micro: Math.round(receivedUsdt * 1_000_000),
      p_tx_hash: txHash,
    });
    if (error) console.error(`${logPrefix}: complete_crypto_buy failed:`, error.message);
    return;
  }

  if (order.status !== "pending") {
    // Already advanced past leg 1 by an earlier settlement attempt.
    return;
  }

  try {
    const { data: account } = await supabase
      .from("crypto_accounts")
      .select("quidax_user_id")
      .eq("user_id", order.user_id)
      .maybeSingle();
    if (!account) {
      console.error(`${logPrefix}: no crypto account for user ${order.user_id}, cannot start buy swap`);
      return;
    }

    const quotation = await createSwapQuotation({
      quidaxUserId: account.quidax_user_id,
      fromCurrency: "usdt",
      toCurrency: swapAsset.quidaxCode,
      fromAmount: String(receivedUsdt),
    });

    await supabase.rpc("record_crypto_buy_swap_pending", {
      p_merchant_reference: merchantReference,
      p_usdt_micro: Math.round(receivedUsdt * 1_000_000),
      p_swap_id: quotation.id,
    });

    try {
      await confirmSwapQuotation({ quidaxUserId: account.quidax_user_id, quotationId: quotation.id });
    } catch (confirmError) {
      const detail = confirmError instanceof Error ? confirmError.message : String(confirmError);
      console.error(`${logPrefix}: buy swap confirm failed:`, detail);
      await supabase.rpc("fail_crypto_buy_swap", { p_swap_id: quotation.id, p_reason: "confirm_failed" });
    }
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.error(`${logPrefix}: could not start buy swap leg:`, detail);
    // Leg 1's USDT is safely in the customer's own sub-account regardless —
    // flagged for follow-up rather than silently stuck 'pending' forever.
    await supabase.rpc("record_monitoring_alert", {
      p_fingerprint: `crypto_buy_swap_start_failed_${merchantReference}`.slice(0, 100).toLowerCase(),
      p_type: "crypto_buy_swap_start_failed",
      p_severity: "warning",
      p_details: { merchant_reference: merchantReference, target_asset: targetAsset, error: detail.slice(0, 300) },
    });
  }
}
