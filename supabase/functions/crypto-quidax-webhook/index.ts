import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { adminClient } from "../_shared/auth.ts";
import {
  createWithdrawal,
  getParentAccount,
  verifyQuidaxWebhookSignature,
} from "../_shared/quidax-client.ts";

// Receives Quidax's webhook deliveries and settles everything that Quidax
// completes asynchronously: incoming deposits, sales (swap USDT -> NGN, then
// credit the user's Naira wallet), and withdrawals. Deposit on-hold/failed/
// rejected variants are logged rather than acted on, since Quidax's own
// compliance layer can hold a deposit and there is nothing to reconcile
// until that resolves. Buy settles here too (Phase 3): the customer pays a
// Quidax-issued one-time bank account and Quidax delivers the USDT, so
// there is no local credit — only the order's status to move.
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  // Signature is computed over the RAW body — must read as text before any
  // JSON parsing, or the signature will never match.
  const rawBody = await req.text();
  const signatureHeader = req.headers.get("quidax-signature");
  const verified = await verifyQuidaxWebhookSignature(rawBody, signatureHeader);
  if (!verified) {
    console.error("crypto-quidax-webhook: signature verification failed");
    return json({ error: "Invalid signature" }, 401);
  }

  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return json({ error: "Invalid payload" }, 400);
  }

  const event = String(payload?.event || "");
  const data = payload?.data ?? {};
  const supabase = adminClient();

  if (event === "deposit.successful") {
    const quidaxUserId = String(data?.user?.id || data?.wallet?.user?.id || "");
    const asset = String(data?.currency || "").toUpperCase();
    const amount = Number(data?.amount);
    const depositId = String(data?.id || "");
    if (!quidaxUserId || !asset || !Number.isFinite(amount) || amount <= 0 || !depositId) {
      console.error("crypto-quidax-webhook: malformed deposit.successful payload", JSON.stringify(payload).slice(0, 300));
      return json({ received: true });
    }

    const { data: account } = await supabase
      .from("crypto_accounts")
      .select("user_id")
      .eq("quidax_user_id", quidaxUserId)
      .maybeSingle();
    if (!account) {
      console.error(`crypto-quidax-webhook: no KaysPay user for Quidax sub-account ${quidaxUserId}`);
      return json({ received: true });
    }

    const cryptoMicro = Math.round(amount * 1_000_000);
    const { error } = await supabase.rpc("record_crypto_deposit", {
      p_user_id: account.user_id,
      p_asset: asset,
      p_crypto_micro: cryptoMicro,
      p_network: String(data?.network || data?.type || ""),
      p_quidax_deposit_id: depositId,
      p_txid: String(data?.txid || ""),
    });
    if (error) {
      console.error("crypto-quidax-webhook: record_crypto_deposit failed:", error.message);
      return json({ error: "Could not record deposit" }, 500);
    }
    return json({ received: true });
  }

  if (["deposit.on_hold", "deposit_failed_aml", "deposit.rejected"].includes(event)) {
    console.warn(`crypto-quidax-webhook: ${event}`, JSON.stringify(data).slice(0, 500));
    return json({ received: true });
  }

  // Sell settled: credit the user's Naira wallet with what they ACTUALLY
  // received, not the earlier quote. Keyed on the quotation id because
  // crypto-sell records the pending row before confirming (so the row
  // always exists), with the swap transaction id as a fallback.
  if (event === "swap_transaction.complete") {
    const swapId = String(data?.swap_quotation?.id || data?.id || "");
    const received = Number(data?.received_amount);
    const toCurrency = String(data?.to_currency || "").toUpperCase();
    if (!swapId || !Number.isFinite(received) || received <= 0 || toCurrency !== "NGN") {
      console.error("crypto-quidax-webhook: unexpected swap_transaction.complete", JSON.stringify(payload).slice(0, 300));
      return json({ received: true });
    }

    const ngnKobo = Math.round(received * 100);
    const { data: txId, error } = await supabase.rpc("complete_crypto_sell", {
      p_swap_id: swapId,
      p_ngn_kobo: ngnKobo,
    });
    if (error) {
      console.error("crypto-quidax-webhook: complete_crypto_sell failed:", error.message);
      return json({ error: "Could not settle sale" }, 500);
    }
    if (!txId) {
      console.warn(`crypto-quidax-webhook: no pending sale for swap ${swapId}`);
      return json({ received: true });
    }

    await sweepNairaToMainAccount(supabase, txId, received);
    return json({ received: true });
  }

  if (event === "swap_transaction.failed") {
    const swapId = String(data?.swap_quotation?.id || data?.id || "");
    if (swapId) {
      await supabase.rpc("fail_crypto_sell", { p_swap_id: swapId, p_reason: "swap_failed" });
    }
    return json({ received: true });
  }

  // Withdrawals (both external sends and our own internal NGN sweeps) are
  // matched on the reference we generated when starting them.
  if (event === "withdraw.successful" || event === "withdraw.rejected") {
    const reference = String(data?.reference || "");
    if (!reference) {
      console.error("crypto-quidax-webhook: withdraw event with no reference", JSON.stringify(payload).slice(0, 300));
      return json({ received: true });
    }
    const { error } = await supabase.rpc("settle_crypto_withdrawal", {
      p_reference: reference,
      p_succeeded: event === "withdraw.successful",
      p_txid: data?.txid ? String(data.txid) : null,
      p_reason: event === "withdraw.rejected" ? String(data?.reason || "rejected") : null,
    });
    if (error) {
      console.error("crypto-quidax-webhook: settle_crypto_withdrawal failed:", error.message);
      return json({ error: "Could not settle withdrawal" }, 500);
    }
    return json({ received: true });
  }

  // Buy settled: the customer's bank transfer cleared and Quidax delivered
  // the USDT into their own sub-account. Nothing is credited locally — the
  // coin is real and the balance is read live from Quidax — so this only
  // moves the order out of "pending" and records what actually arrived.
  if (event === "buy_transaction.successful") {
    const merchantReference = String(data?.merchant_reference || "");
    const received = Number(data?.crypto_payout?.amount ?? data?.to_amount);
    if (!merchantReference || !Number.isFinite(received) || received <= 0) {
      console.error("crypto-quidax-webhook: unexpected buy_transaction.successful", JSON.stringify(payload).slice(0, 300));
      return json({ received: true });
    }
    const { data: txId, error } = await supabase.rpc("complete_crypto_buy", {
      p_merchant_reference: merchantReference,
      p_crypto_micro: Math.round(received * 1_000_000),
      p_tx_hash: data?.crypto_payout?.transaction_hash
        ? String(data.crypto_payout.transaction_hash)
        : null,
    });
    if (error) {
      console.error("crypto-quidax-webhook: complete_crypto_buy failed:", error.message);
      return json({ error: "Could not settle purchase" }, 500);
    }
    if (!txId) console.warn(`crypto-quidax-webhook: no pending buy for ${merchantReference}`);
    return json({ received: true });
  }

  if (event === "buy_transaction.failed") {
    const merchantReference = String(data?.merchant_reference || "");
    if (merchantReference) {
      // Nothing to refund: the money never left the customer's own bank.
      await supabase.rpc("fail_crypto_buy", {
        p_merchant_reference: merchantReference,
        p_reason: String(data?.status || "failed"),
      });
    }
    return json({ received: true });
  }

  // The customer's transfer landed but Quidax hasn't delivered the crypto
  // yet — the order is already 'pending' here, so there is nothing to change.
  if (event === "buy_transaction.processing") {
    return json({ received: true });
  }

  // Any other event type — acknowledge so Quidax doesn't keep retrying.
  return json({ received: true });
});

/**
 * Moves the NGN a sale produced out of the user's sub-account and into the
 * merchant's main account. The user has already been credited in the app at
 * this point, so a failure here is a settlement problem for KaysPay to
 * resolve — never the customer's — and the funds are still safely inside
 * the merchant's own Quidax umbrella. Raised as a monitoring alert rather
 * than failing the webhook, since retrying the whole webhook would not
 * re-run the credit (which is idempotent) and Quidax would keep redelivering.
 */
async function sweepNairaToMainAccount(
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
    console.error("crypto-quidax-webhook: NGN sweep to main account failed:", detail);
    await supabase.rpc("record_monitoring_alert", {
      p_fingerprint: `crypto_sell_sweep_failed_${txId}`.slice(0, 100).toLowerCase(),
      p_type: "crypto_sell_sweep_failed",
      p_severity: "warning",
      p_details: { transaction_id: txId, ngn_amount: ngnAmount, error: detail.slice(0, 300) },
    });
  }
}
