import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { adminClient } from "../_shared/auth.ts";
import { verifyQuidaxWebhookSignature } from "../_shared/quidax-client.ts";
import { sweepNairaToMainAccount } from "../_shared/crypto-sell-sweep.ts";
import { notifyCryptoBuyCompleted } from "../_shared/crypto-buy-settle.ts";
import { deriveVerifiedQuidaxIdentity } from "../_shared/crypto-account.ts";
import { executeUsdtOffRampWithdrawal, openUsdtOffRampSale } from "../_shared/crypto-sell-offramp.ts";
import { notifyCryptoSwapCompleted, notifyCryptoSwapFailed } from "../_shared/crypto-swap-notify.ts";
import { redactSecrets } from "../_shared/redact.ts";

// Receives Quidax's webhook deliveries and settles everything that Quidax
// completes asynchronously: incoming deposits, sales (swap USDT -> NGN, then
// credit the user's Naira wallet), and withdrawals. Deposit on-hold/failed/
// rejected variants are logged rather than acted on, since Quidax's own
// compliance layer can hold a deposit and there is nothing to reconcile
// until that resolves. Buy does NOT settle here �?it runs on Quidax's Ramp
// product, which signs its webhooks differently and has its own dashboard
// URL, so it lives in crypto-ramp-webhook.
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
  });
}

serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  // Signature is computed over the RAW body �?must read as text before any
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
      console.error("crypto-quidax-webhook: malformed deposit.successful payload", JSON.stringify({ quidaxUserId, asset, amount, depositId }));
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

    // Quidax's deposit.successful fires for ANY crypto landing in this
    // sub-account -- including a Buy's own leg 1 (Ramp NGN -> USDT), which
    // is not an external deposit at all. Without this check, every single
    // completed Buy also produced a second, redundant crypto_deposit row
    // (amount_ngn hardcoded 0) duplicating what the crypto_buy transaction
    // already fully represents -- confusing both the customer's own History
    // and anything the admin panel sums from this table. A recently
    // settled/settling Buy for the same user+asset means this deposit is
    // that Buy landing, not a real external deposit. 30 minutes covers the
    // ~2-3 minute typical settlement time with generous headroom; the real
    // crypto balance is always read live from Quidax, never summed from
    // these rows, so the only possible downside of a false match is one
    // missing Deposit history row, never a wrong balance.
    const { data: recentBuy } = await supabase
      .from("transactions")
      .select("id")
      .eq("user_id", account.user_id)
      .eq("type", "crypto_buy")
      .eq("metadata->>asset", asset)
      .in("status", ["pending", "completed"])
      .gte("created_at", new Date(Date.now() - 30 * 60 * 1000).toISOString())
      .limit(1)
      .maybeSingle();
    if (recentBuy) {
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
    console.warn(`crypto-quidax-webhook: ${event}`, JSON.stringify({
      depositId: data?.id, currency: data?.currency, amount: data?.amount, reason: data?.reason,
    }));
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
      console.error("crypto-quidax-webhook: unexpected swap_transaction.complete", JSON.stringify({ swapId: data?.swap_quotation?.id || data?.id, received: data?.received_amount, toCurrency: data?.to_currency }));
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

    // A customer-initiated Swap (migration 212) -- coin -> coin directly,
    // no off-ramp leg at all: the destination coin lands straight back in
    // the same sub-account, so there's nothing further to do here beyond
    // marking it complete and notifying. Checked before the Sell-via-swap
    // branch below since that one only ever targets USDT and this one can
    // target any of the 9 coins; both claims are no-op-safe against a swap
    // id that isn't theirs, so the order between them doesn't matter for
    // correctness, only for which runs its (cheap) no-op check first.
    const { data: swapRows, error: swapError } = await supabase.rpc("complete_crypto_swap", {
      p_swap_quotation_id: swapId,
      p_to_crypto_micro: Math.round(received * 1_000_000),
    });
    if (swapError) {
      console.error("crypto-quidax-webhook: complete_crypto_swap failed:", swapError.message);
      return json({ error: "Could not settle swap" }, 500);
    }
    const swapRow = swapRows?.[0];
    if (swapRow) {
      await notifyCryptoSwapCompleted(supabase, {
        userId: swapRow.user_id,
        fromAsset: swapRow.from_asset,
        toAsset: swapRow.to_asset,
        fromAmount: Number(swapRow.from_crypto_micro) / 1_000_000,
        toAmount: received,
      });
      return json({ received: true });
    }

    // Leg 1 of a non-USDT Sell (see migration 211 and
    // _shared/crypto-sell-offramp.ts): the source coin just finished
    // swapping to USDT inside the customer's own sub-account. Claims the
    // pending sale (a no-op if this swap id isn't one of these -- same
    // not-mine-move-on contract as complete_crypto_buy_swap above, and
    // safe against a retried webhook delivery re-claiming the same sale
    // twice) and runs the exact same off-ramp leg 2 a direct USDT sale uses.
    if (toCurrency === "USDT") {
      const { data: claimedRows, error: claimError } = await supabase.rpc("claim_crypto_sell_swap_for_offramp", {
        p_swap_quotation_id: swapId,
        p_usdt_crypto_micro: Math.round(received * 1_000_000),
      });
      if (claimError) {
        console.error("crypto-quidax-webhook: claim_crypto_sell_swap_for_offramp failed:", claimError.message);
        return json({ error: "Could not continue this sale" }, 500);
      }
      const claimed = claimedRows?.[0];
      if (!claimed) {
        console.warn(`crypto-quidax-webhook: no pending sell-via-swap for swap ${swapId}`);
        return json({ received: true });
      }

      const identity = await deriveVerifiedQuidaxIdentity(supabase, { id: claimed.user_id });
      const { data: account } = await supabase
        .from("crypto_accounts")
        .select("quidax_user_id")
        .eq("user_id", claimed.user_id)
        .maybeSingle();
      if (!identity || !account) {
        console.error("crypto-quidax-webhook: missing identity/account for sell-via-swap", JSON.stringify({ transactionId: claimed.transaction_id }));
        await supabase.rpc("fail_crypto_sell_swap_leg", { p_transaction_id: claimed.transaction_id, p_reason: "missing_identity_or_account" });
        return json({ received: true });
      }

      const merchantReference = `cs${Date.now()}${crypto.randomUUID().slice(0, 8)}`;
      const usdtAmount = Math.round(received * 10_000) / 10_000;

      let opened;
      try {
        opened = await openUsdtOffRampSale({
          merchantReference,
          cryptoAmount: usdtAmount,
          email: identity.email,
          firstName: identity.firstName,
          lastName: identity.lastName,
          bankCode: claimed.bank_code,
          accountNumber: claimed.recipient_account_number,
        });
      } catch (e) {
        console.error("crypto-quidax-webhook: openUsdtOffRampSale threw:", redactSecrets(e instanceof Error ? e.message : String(e)));
        await supabase.rpc("fail_crypto_sell_swap_leg", { p_transaction_id: claimed.transaction_id, p_reason: "offramp_open_failed" });
        return json({ received: true });
      }
      if (!opened.success) {
        // Nothing has left the sub-account yet -- the USDT just sits there,
        // recoverable, unlike a createWithdrawal failure below.
        await supabase.rpc("fail_crypto_sell_swap_leg", { p_transaction_id: claimed.transaction_id, p_reason: opened.nameMismatch ? "name_mismatch" : "offramp_open_failed" });
        return json({ received: true });
      }

      await supabase.rpc("finalize_crypto_sell_swap_offramp_init", {
        p_transaction_id: claimed.transaction_id,
        p_reference: opened.reference,
        p_merchant_reference: merchantReference,
      });

      try {
        await executeUsdtOffRampWithdrawal({
          quidaxUserId: account.quidax_user_id,
          cryptoAmount: usdtAmount,
          merchantReference,
          depositAddress: opened.depositAddress!,
          depositNetwork: opened.depositNetwork!,
        });
      } catch (withdrawError) {
        // From here on this transaction carries a real quidax_reference, so
        // it's indistinguishable from a direct USDT sale that failed after
        // confirm -- same critical, "crypto may already have moved
        // on-chain" handling via the existing RPC, not the softer one above.
        await supabase.rpc("fail_crypto_sell_offramp", { p_reference: merchantReference, p_reason: "withdrawal_failed" });
        console.error("crypto-quidax-webhook: sell-via-swap withdrawal failed:", redactSecrets(withdrawError instanceof Error ? withdrawError.message : String(withdrawError)));
      }

      return json({ received: true });
    }

    if (toCurrency !== "NGN") {
      console.error("crypto-quidax-webhook: swap_transaction.complete matched neither a buy nor a sell", JSON.stringify({ swapId, received, toCurrency }));
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
      if (buyTxId) {
        // Same "settled as USDT instead of the requested coin" case as the
        // confirm_failed path in crypto-buy-settle.ts �?leg 1's USDT already
        // landed, so this still deserves the completion notification.
        const { data: buyTx } = await supabase
          .from("transactions")
          .select("user_id, metadata")
          .eq("id", buyTxId)
          .maybeSingle();
        const settledMicro = Number(buyTx?.metadata?.crypto_micro);
        if (buyTx && Number.isFinite(settledMicro) && settledMicro > 0) {
          await notifyCryptoBuyCompleted(supabase, {
            userId: buyTx.user_id,
            asset: "USDT",
            amount: settledMicro / 1_000_000,
            destinationType: buyTx.metadata?.destination_type,
            substitutedFromAsset: String(buyTx.metadata?.asset || "").toUpperCase() || undefined,
          });
        }
      } else {
        // Customer-initiated Swap (migration 212) -- no-op if this swap id
        // isn't one of these. Nothing was lost: the FROM coin never left
        // the sub-account, so this just settles the row failed and
        // reassures the customer rather than escalating.
        const { data: failedRows } = await supabase.rpc("fail_crypto_swap", { p_swap_quotation_id: swapId, p_reason: "swap_failed" });
        const failedRow = failedRows?.[0];
        if (failedRow) {
          await notifyCryptoSwapFailed(supabase, { userId: failedRow.user_id, fromAsset: failedRow.from_asset, toAsset: failedRow.to_asset });
        } else {
          await supabase.rpc("fail_crypto_sell", { p_swap_id: swapId, p_reason: "swap_failed" });
        }
      }
    }
    return json({ received: true });
  }

  // Withdrawals (both external sends and our own internal NGN sweeps) are
  // matched on the reference we generated when starting them.
  if (event === "withdraw.successful" || event === "withdraw.rejected") {
    const reference = String(data?.reference || "");
    if (!reference) {
      console.error("crypto-quidax-webhook: withdraw event with no reference", JSON.stringify({ event, currency: data?.currency, amount: data?.amount }));
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

  // Any other event type �?acknowledge so Quidax doesn't keep retrying.
  return json({ received: true });
});
