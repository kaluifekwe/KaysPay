import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { adminClient } from "../_shared/auth.ts";
import { verifyQuidaxWebhookSignature } from "../_shared/quidax-client.ts";
import { sweepNairaToMainAccount } from "../_shared/crypto-sell-sweep.ts";
import { notifyCryptoBuyCompleted } from "../_shared/crypto-buy-settle.ts";

// Receives Quidax's webhook deliveries and settles everything that Quidax
// completes asynchronously: incoming deposits, sales (swap USDT -> NGN, then
// credit the user's Naira wallet), and withdrawals. Deposit on-hold/failed/
// rejected variants are logged rather than acted on, since Quidax's own
// compliance layer can hold a deposit and there is nothing to reconcile
// until that resolves. Buy does NOT settle here — it runs on Quidax's Ramp
// product, which signs its webhooks differently and has its own dashboard
// URL, so it lives in crypto-ramp-webhook.
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

  // A swap completing is shared by two different flows: Sell (USDT -> NGN,
  // credited to the wallet) and Buy's leg 2 for a non-USDT coin (USDT ->
  // target coin, inside the customer's own sub-account, nothing to credit
  // locally). Buy's leg 2 is checked first since it's a no-op RETURN NULL
  // when the swap id isn't one of its own, which is the same
  // not-mine-move-on contract complete_crypto_sell already used alone.
  if (event === "swap_transaction.complete") {
    const swapId = String(data?.swap_quotation?.id || data?.id || "");
    const received = Number(data?.received_amount);
    const toCurrency = String(data?.to_currency || "").toUpperCase();
    if (!swapId || !Number.isFinite(received) || received <= 0) {
      console.error("crypto-quidax-webhook: unexpected swap_transaction.complete", JSON.stringify(payload).slice(0, 300));
      return json({ received: true });
    }

    const { data: buyTxId, error: buyError } = await supabase.rpc("complete_crypto_buy_swap", {
      p_swap_id: swapId,
      p_crypto_micro: Math.round(received * 1_000_000),
    });
    if (buyError) {
      console.error("crypto-quidax-webhook: complete_crypto_buy_swap failed:", buyError.message);
      return json({ error: "Could not settle purchase" }, 500);
    }
    if (buyTxId) {
      const { data: buyTx } = await supabase
        .from("transactions")
        .select("user_id, metadata")
        .eq("id", buyTxId)
        .maybeSingle();
      if (buyTx) {
        await notifyCryptoBuyCompleted(supabase, {
          userId: buyTx.user_id,
          asset: toCurrency,
          amount: received,
          destinationType: buyTx.metadata?.destination_type,
        });
      }
      return json({ received: true });
    }

    if (toCurrency !== "NGN") {
      console.error("crypto-quidax-webhook: swap_transaction.complete matched neither a buy nor a sell", JSON.stringify(payload).slice(0, 300));
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
      const { data: buyTxId } = await supabase.rpc("fail_crypto_buy_swap", { p_swap_id: swapId, p_reason: "swap_failed" });
      if (!buyTxId) {
        await supabase.rpc("fail_crypto_sell", { p_swap_id: swapId, p_reason: "swap_failed" });
      }
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

  // Buy runs on the separate Quidax RAMP product: its buy_transaction.*
  // webhooks are signed with x-ramp-signature and delivered to their own
  // dashboard URL, so they are handled in crypto-ramp-webhook, not here.

  // Any other event type — acknowledge so Quidax doesn't keep retrying.
  return json({ received: true });
});
