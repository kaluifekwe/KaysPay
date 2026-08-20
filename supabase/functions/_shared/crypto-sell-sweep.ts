import type { adminClient } from "./auth.ts";
import { createWithdrawal, getParentAccount } from "./quidax-client.ts";

/**
 * Moves the NGN a sale produced out of the user's sub-account and into the
 * merchant's main account. The user has already been credited in the app at
 * this point, so a failure here is a settlement problem for KaysPay to
 * resolve — never the customer's — and the funds are still safely inside
 * the merchant's own Quidax umbrella. Raised as a monitoring alert rather
 * than thrown, since the caller (webhook or reconcile) has already settled
 * the customer and shouldn't retry or fail because of this.
 *
 * Shared between crypto-quidax-webhook (the normal path) and
 * crypto-sell-reconcile (the fallback path) — the reconcile sweep was
 * originally missing this step entirely, which let a reconcile-settled sale
 * credit the customer without ever consolidating the backing NGN.
 */
export async function sweepNairaToMainAccount(
  supabase: ReturnType<typeof adminClient>,
  txId: string,
  ngnAmount: number,
): Promise<void> {
  try {
    const { data: tx } = await supabase
      .from("transactions")
      .select("user_id")
      .eq("id", txId)
      .maybeSingle();
    if (!tx) return;

    const { data: account } = await supabase
      .from("crypto_accounts")
      .select("quidax_user_id")
      .eq("user_id", tx.user_id)
      .maybeSingle();
    if (!account) return;

    const parent = await getParentAccount();
    await createWithdrawal({
      quidaxUserId: account.quidax_user_id,
      currency: "ngn",
      amount: String(ngnAmount),
      fundUid: parent.id,
      reference: `sweep_${txId}`,
      narration: "KaysPay sale settlement",
    });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.error("crypto-sell-sweep: NGN sweep to main account failed:", detail);
    await supabase.rpc("record_monitoring_alert", {
      p_fingerprint: `crypto_sell_sweep_failed_${txId}`.slice(0, 100).toLowerCase(),
      p_type: "crypto_sell_sweep_failed",
      p_severity: "warning",
      p_details: { transaction_id: txId, ngn_amount: ngnAmount, error: detail.slice(0, 300) },
    });
  }
}
