import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import {
  adminClient,
  consumeAuthToken,
  enforceRateLimit,
  getAuthUser,
  isDeviceSessionAllowed,
  isServiceEnabled,
  readJsonBody,
  RequestBodyError,
} from "../_shared/auth.ts";
import { deriveVerifiedQuidaxIdentity, getOrCreateCryptoAccount } from "../_shared/crypto-account.ts";
import { createSwapQuotation, confirmSwapQuotation, getCryptoWithdrawalFee, getSubAccountWallets, isQuidaxConfigured } from "../_shared/quidax-client.ts";
import { isQuidaxRampConfigured, QuidaxRampError } from "../_shared/quidax-ramp-client.ts";
import { executeUsdtOffRampWithdrawal, openUsdtOffRampSale, OFFRAMP_USDT_NETWORK } from "../_shared/crypto-sell-offramp.ts";
import { redactSecrets } from "../_shared/redact.ts";

// Sell: pays the customer's bank account DIRECTLY via Quidax's Ramp
// off-ramp, using Quidax's own liquidity — never touches the KaysPay
// wallet. Replaces the previous internal-swap-then-credit-wallet mechanism
// (migration 119, now unused) — owner decision 2026-08-20, driven by not
// having float capital to keep Flutterwave/Paystack payout balances funded
// for a wallet-based Transfer-out step. See migration 139.
//
// Every asset but USDT has no off-ramp of its own -- it's swapped to USDT
// INSIDE the customer's own sub-account first (internal ledger conversion,
// no on-chain movement, no destination-tag risk even for XRP), then the
// same off-ramp below runs on the resulting USDT. That swap settles
// asynchronously (crypto-quidax-webhook's swap_transaction.complete), so
// this request returns "pending" right after confirming the swap, same as
// the USDT path already returns "pending" right after initiating the
// on-chain withdrawal rather than waiting for it to settle. See migration
// 211 and _shared/crypto-sell-offramp.ts.
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
  });
}

const MIN_USDT = 1;
const MAX_USDT = 2000;
const SUPPORTED_ASSETS = ["USDT", "BTC", "ETH", "SOL", "XRP", "TRX", "LTC", "DOGE", "ADA"];

serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  const user = await getAuthUser(req);
  if (!user) return json({ error: "Unauthorized" }, 401);

  if (!isQuidaxConfigured() || !isQuidaxRampConfigured()) {
    return json({ success: false, error: "Crypto isn't available yet." }, 503);
  }

  let body: any;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    const e = error instanceof RequestBodyError ? error : new RequestBodyError(400, "Invalid request body");
    return json({ error: e.message }, e.status);
  }

  const supabase = adminClient();

  if (!(await isServiceEnabled(supabase, "crypto"))) {
    return json({ success: false, error: "Crypto is temporarily unavailable. Please try again later." }, 503);
  }

  if (!(await isDeviceSessionAllowed(req, supabase, user.id))) {
    return json({ error: "This device session has been revoked. Please log in again." }, 401);
  }

  const rate = await enforceRateLimit(supabase, "crypto_sell", user.id, 20, 300, user.id);
  if (!rate.allowed) {
    return json({
      success: false,
      error: "Too many attempts. Please wait a few minutes and try again.",
      retry_after_seconds: rate.retryAfterSeconds,
    }, 429);
  }

  const asset = String(body.asset || "USDT").toUpperCase();
  // Rounded to 4dp here, once, and used for every downstream call (balance
  // check, fee check, initiateOffRamp/swap_quotation, the persisted
  // crypto_micro, and the final createWithdrawal). Real incident: a
  // client-computed amount with 5+ decimals (e.g. 4.70644) was sent as-is to
  // initiateOffRamp, which quotes/expects only 4dp on Quidax's side
  // (4.7064) -- the two legs then disagreed on the actual on-chain deposit,
  // and Quidax's system held the sale for manual review over a discrepancy
  // that was entirely ours to avoid. Confirmed directly by Quidax support,
  // not guessed.
  const cryptoAmount = Math.round(Number(body.crypto_amount) * 10_000) / 10_000;
  const bankCode = String(body.bank_code || "").trim();
  const bankName = String(body.bank_name || "").trim();
  const accountNumber = String(body.account_number || "").trim();
  if (!SUPPORTED_ASSETS.includes(asset)) {
    return json({ success: false, error: "Unsupported asset" }, 400);
  }
  if (!Number.isFinite(cryptoAmount) || cryptoAmount <= 0) {
    return json({ success: false, error: "Enter a valid amount." }, 400);
  }
  if (asset === "USDT" && (cryptoAmount < MIN_USDT || cryptoAmount > MAX_USDT)) {
    return json({ success: false, error: `Enter an amount between ${MIN_USDT} and ${MAX_USDT} USDT` }, 400);
  }
  if (!bankCode || !bankName) {
    return json({ success: false, error: "Select a bank." }, 400);
  }
  if (!/^\d{10}$/.test(accountNumber)) {
    return json({ success: false, error: "Enter a valid 10-digit account number." }, 400);
  }

  const idempotencyKey = String(body.idempotency_key || `crypto_sell_${user.id}_${Date.now()}`);

  // Idempotency short-circuit BEFORE the PIN/biometric token is spent and
  // BEFORE any Quidax call — same discipline as transfer-send. Found by the
  // 2026-08-20 Strix pentest (vuln-0001/0004): without this, a replayed
  // request (retry, double-tap, a fresh step-up token on the same logical
  // sale) sailed straight through to a SECOND real Quidax withdrawal, since
  // the old code only checked idempotency reactively after already
  // initiating a new off-ramp transaction.
  const { data: existingTx } = await supabase
    .from("transactions")
    .select("id, status")
    .eq("metadata->>idempotency_key", idempotencyKey)
    .maybeSingle();

  if (existingTx) {
    if (existingTx.status === "failed") {
      return json({ success: false, error: "This sale already failed. Please start a new sale." });
    }
    return json({
      success: true,
      pending: existingTx.status !== "completed",
      transaction_id: existingTx.id,
      message: existingTx.status === "completed"
        ? "This sale already completed."
        : "Your sale is still processing. You'll be notified once it completes.",
    });
  }

  const authorized = await consumeAuthToken(supabase, user.id, body.auth_token);
  if (!authorized) {
    return json({ success: false, error: "Re-authorization required. Please try again." }, 401);
  }

  const cryptoMicro = Math.round(cryptoAmount * 1_000_000);
  const merchantReference = `cs${Date.now()}${crypto.randomUUID().slice(0, 8)}`;

  try {
    const account = await getOrCreateCryptoAccount(supabase, user);
    // Server-trusted identity for the off-ramp's name-match check — never
    // the mutable profile name (see deriveVerifiedQuidaxIdentity's own
    // comment for why: Strix pentest 2026-08-20, vuln-0002/0003).
    const identity = await deriveVerifiedQuidaxIdentity(supabase, user);
    if (!identity) {
      return json({ success: false, error: "Complete identity verification before selling crypto to a bank account." }, 403);
    }

    // Balance is checked against Quidax, never a local number — a stale
    // local copy could authorize a sale the user can't actually cover.
    const wallets = await getSubAccountWallets(account.quidaxUserId);
    const wallet = wallets.find((w) => w.currency.toLowerCase() === asset.toLowerCase());
    const available = Number(wallet?.balance ?? 0);
    if (!Number.isFinite(available) || available < cryptoAmount) {
      return json({ success: false, error: `Insufficient ${asset} balance.` });
    }

    if (asset === "USDT") {
      // Quidax deducts the network fee on top of `amount` (e.g. amount 1 +
      // fee 1 = total 2 in their documented withdrawal response). The old
      // check compared only `amount`, so a full-balance sale passed locally
      // and then bounced when createWithdrawal reached Quidax.
      const withdrawalFee = await getCryptoWithdrawalFee({
        currency: asset,
        amount: cryptoAmount,
        network: OFFRAMP_USDT_NETWORK,
      });
      const totalRequired = cryptoAmount + withdrawalFee.fee;
      if (available + 1e-8 < totalRequired) {
        return json({
          success: false,
          error: `You need ${totalRequired.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")} USDT: ${cryptoAmount} USDT to sell plus ${withdrawalFee.fee} USDT network fee.`,
          network_fee: withdrawalFee.fee,
          total_required: totalRequired,
          available,
        }, 400);
      }

      const opened = await openUsdtOffRampSale({
        merchantReference,
        cryptoAmount,
        email: identity.email,
        firstName: identity.firstName,
        lastName: identity.lastName,
        bankCode,
        accountNumber,
      });
      if (!opened.success) {
        return json({ success: false, error: opened.error }, opened.nameMismatch ? 400 : 500);
      }

      // Recorded BEFORE the crypto actually leaves the sub-account — the
      // withdrawal below is the irreversible step, same discipline as the
      // old flow recording before confirmSwapQuotation.
      const { data: txId, error: recordError } = await supabase.rpc("record_crypto_sell_offramp_pending", {
        p_user_id: user.id,
        p_asset: asset,
        p_crypto_micro: cryptoMicro,
        p_reference: opened.reference,
        p_merchant_reference: merchantReference,
        p_recipient_bank_name: bankName,
        p_recipient_account_number: accountNumber,
        p_idempotency_key: idempotencyKey,
      });
      if (recordError) {
        console.error("crypto-sell: could not record pending sale:", recordError.message);
        return json({ success: false, error: "Could not start the sale. Please try again." }, 500);
      }

      try {
        await executeUsdtOffRampWithdrawal({
          quidaxUserId: account.quidaxUserId,
          cryptoAmount,
          merchantReference,
          depositAddress: opened.depositAddress!,
          depositNetwork: opened.depositNetwork!,
        });
      } catch (withdrawError) {
        // The crypto may or may not have actually moved at this point — no
        // wallet debit exists to roll back either way, so this is flagged
        // for manual follow-up rather than silently failed (see migration 139).
        await supabase.rpc("fail_crypto_sell_offramp", { p_reference: merchantReference, p_reason: "withdrawal_failed" });
        const detail = withdrawError instanceof Error ? withdrawError.message : String(withdrawError);
        console.error("crypto-sell: withdrawal to off-ramp deposit address failed:", redactSecrets(detail));
        return json({ success: false, error: "Could not complete the sale. Our team has been notified." }, 500);
      }

      return json({
        success: true,
        pending: true,
        transaction_id: txId,
        asset,
        crypto_micro: cryptoMicro,
        message: `Your sale is processing. ${bankName} account ${accountNumber} will be credited once it settles.`,
      });
    }

    // Non-USDT: swap to USDT inside the customer's own sub-account first.
    // The quote itself surfaces Quidax's real live minimum for this asset
    // (e.g. "Minimum TRX value should be above 3.02") rather than KaysPay
    // guessing one — confirmed live against all 8 supported coins,
    // 2026-09-05.
    let quote;
    try {
      quote = await createSwapQuotation({
        quidaxUserId: account.quidaxUserId,
        fromCurrency: asset.toLowerCase(),
        toCurrency: "usdt",
        fromAmount: String(cryptoAmount),
      });
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      return json({ success: false, error: detail }, 400);
    }

    const estimatedUsdt = Number(quote.toAmount);
    if (!Number.isFinite(estimatedUsdt) || estimatedUsdt < MIN_USDT || estimatedUsdt > MAX_USDT) {
      return json({
        success: false,
        error: `This would sell for about ${Number.isFinite(estimatedUsdt) ? estimatedUsdt.toFixed(2) : "?"} USDT — sales must be worth between ${MIN_USDT} and ${MAX_USDT} USDT.`,
      }, 400);
    }

    // Recorded BEFORE confirming the swap — the swap is the irreversible
    // step for this leg (the source coin is gone the instant it settles),
    // same "record before the irreversible step" discipline as the USDT
    // path above.
    const { data: txId, error: recordError } = await supabase.rpc("record_crypto_sell_swap_pending", {
      p_user_id: user.id,
      p_source_asset: asset,
      p_source_crypto_micro: cryptoMicro,
      p_swap_quotation_id: quote.id,
      p_recipient_bank_name: bankName,
      p_recipient_account_number: accountNumber,
      p_bank_code: bankCode,
      p_idempotency_key: idempotencyKey,
    });
    if (recordError) {
      console.error("crypto-sell: could not record pending swap-sell:", recordError.message);
      return json({ success: false, error: "Could not start the sale. Please try again." }, 500);
    }

    try {
      await confirmSwapQuotation({ quidaxUserId: account.quidaxUserId, quotationId: quote.id });
    } catch (e) {
      await supabase.rpc("fail_crypto_sell_swap_pending", { p_swap_quotation_id: quote.id, p_reason: "swap_confirm_failed" });
      const detail = e instanceof Error ? e.message : String(e);
      console.error("crypto-sell: swap confirm failed:", redactSecrets(detail));
      return json({ success: false, error: "Could not complete the sale. Please try again." }, 500);
    }

    return json({
      success: true,
      pending: true,
      transaction_id: txId,
      asset,
      crypto_micro: cryptoMicro,
      message: `Your sale is processing. ${bankName} account ${accountNumber} will be credited once it settles.`,
    });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    const status = e instanceof QuidaxRampError ? e.status : undefined;
    console.error("crypto-sell failed:", redactSecrets(JSON.stringify({ status, detail })));
    return json({ success: false, error: "Could not complete the sale. Please try again." }, 500);
  }
});
