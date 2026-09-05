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
import { getOrCreateCryptoAccount } from "../_shared/crypto-account.ts";
import { confirmSwapQuotation, createSwapQuotation, getSubAccountWallets, isQuidaxConfigured } from "../_shared/quidax-client.ts";
import { notifyCryptoSwapFailed } from "../_shared/crypto-swap-notify.ts";
import { redactSecrets } from "../_shared/redact.ts";

// Converts one held coin directly into another, entirely inside the
// customer's own Quidax sub-account -- all 9 supported coins, either
// direction. Unlike Sell there's no off-ramp leg: the destination coin
// lands straight back in the same sub-account, and the live wallet read
// (getSubAccountWallets) picks it up with no further action from KaysPay.
// So this is a single-leg async settlement -- confirmSwapQuotation comes
// back "initiated" and the real result arrives via
// crypto-quidax-webhook's swap_transaction.complete/.failed, matched on
// the swap_quotation id (see migration 212).
//
// The quote preview lives in THIS same function (body.mode === "quote")
// rather than its own crypto-swap-quote function, the way Sell/Withdraw's
// quote endpoints are split out -- the Supabase project is at its hard
// 100-function cap (confirmed live via a 402 "Max number of functions
// reached" 2026-09-05) with exactly one free slot, and splitting this into
// two functions the way convention would suggest needed two. Owner chose
// this over deleting another function or upgrading the plan.
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders(), "Content-Type": "application/json" } });
}

const SUPPORTED_ASSETS = ["USDT", "BTC", "ETH", "SOL", "XRP", "TRX", "LTC", "DOGE", "ADA"];

serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  const user = await getAuthUser(req);
  if (!user) return json({ error: "Unauthorized" }, 401);
  if (!isQuidaxConfigured()) return json({ success: false, error: "Crypto isn't available yet." }, 503);

  let body: any;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    const e = error instanceof RequestBodyError ? error : new RequestBodyError(400, "Invalid request body");
    return json({ error: e.message }, e.status);
  }

  const supabase = adminClient();
  const isQuote = body.mode === "quote";

  if (!(await isServiceEnabled(supabase, "crypto"))) {
    return json({ success: false, error: "Crypto is temporarily unavailable. Please try again later." }, 503);
  }
  if (!(await isDeviceSessionAllowed(req, supabase, user.id))) {
    return json({ error: "This device session has been revoked. Please log in again." }, 401);
  }

  const fromAsset = String(body.from_asset || "").toUpperCase();
  const toAsset = String(body.to_asset || "").toUpperCase();
  // Same 4dp rounding discipline as crypto-sell -- Quidax's swap_quotation
  // only accepts up to 4dp, and letting a client-computed value carry more
  // than that has previously caused the two legs to disagree (see the note
  // in crypto-sell/index.ts, confirmed directly by Quidax support).
  const cryptoAmount = Math.round(Number(body.crypto_amount) * 10_000) / 10_000;

  if (!SUPPORTED_ASSETS.includes(fromAsset) || !SUPPORTED_ASSETS.includes(toAsset)) {
    return json({ success: false, error: "Unsupported asset" }, 400);
  }
  if (fromAsset === toAsset) return json({ success: false, error: "Pick two different coins." }, 400);
  if (!Number.isFinite(cryptoAmount) || cryptoAmount <= 0) {
    return json({ success: false, error: "Enter a valid amount." }, 400);
  }

  // Quote preview: read-only, no auth token, no idempotency, no db write --
  // same "quotes are read-only and cost nothing" reasoning crypto-sell-quote
  // already relies on for its own non-USDT preview. Its own, higher rate
  // limit (30/300s, matching every other -quote endpoint) since it's safe
  // to call on every keystroke, unlike the real swap below (20/300s).
  if (isQuote) {
    const rate = await enforceRateLimit(supabase, "crypto_swap_quote", user.id, 30, 300, user.id);
    if (!rate.allowed) return json({ success: false, error: "Too many checks. Please wait and try again." }, 429);

    try {
      const account = await getOrCreateCryptoAccount(supabase, user);
      const wallets = await getSubAccountWallets(account.quidaxUserId);
      const wallet = wallets.find((w) => w.currency.toLowerCase() === fromAsset.toLowerCase());
      const available = Number(wallet?.balance ?? 0);

      let quote;
      try {
        quote = await createSwapQuotation({
          quidaxUserId: account.quidaxUserId,
          fromCurrency: fromAsset.toLowerCase(),
          toCurrency: toAsset.toLowerCase(),
          fromAmount: String(cryptoAmount),
        });
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        return json({ success: false, error: detail }, 400);
      }

      const estimatedToAmount = Number(quote.toAmount);
      const sufficient = Number.isFinite(available) && available + 1e-8 >= cryptoAmount;

      return json({
        success: true,
        from_asset: fromAsset,
        to_asset: toAsset,
        amount: cryptoAmount,
        estimated_to_amount: Number.isFinite(estimatedToAmount) ? estimatedToAmount : null,
        quoted_price: quote.quotedPrice,
        available,
        sufficient,
      });
    } catch {
      return json({ success: false, error: "Could not price this swap. Please try again." }, 503);
    }
  }

  const rate = await enforceRateLimit(supabase, "crypto_swap", user.id, 20, 300, user.id);
  if (!rate.allowed) {
    return json({
      success: false,
      error: "Too many attempts. Please wait a few minutes and try again.",
      retry_after_seconds: rate.retryAfterSeconds,
    }, 429);
  }

  const idempotencyKey = String(body.idempotency_key || `crypto_swap_${user.id}_${Date.now()}`);

  // Same idempotency short-circuit discipline as crypto-sell -- BEFORE the
  // auth token is spent and BEFORE any Quidax call.
  const { data: existingTx } = await supabase
    .from("transactions")
    .select("id, status")
    .eq("metadata->>idempotency_key", idempotencyKey)
    .maybeSingle();
  if (existingTx) {
    if (existingTx.status === "failed") {
      return json({ success: false, error: "This swap already failed. Please start a new swap." });
    }
    return json({
      success: true,
      pending: existingTx.status !== "completed",
      transaction_id: existingTx.id,
      message: existingTx.status === "completed" ? "This swap already completed." : "Your swap is still processing. You'll be notified once it completes.",
    });
  }

  const authorized = await consumeAuthToken(supabase, user.id, body.auth_token);
  if (!authorized) {
    return json({ success: false, error: "Re-authorization required. Please try again." }, 401);
  }

  const cryptoMicro = Math.round(cryptoAmount * 1_000_000);

  try {
    const account = await getOrCreateCryptoAccount(supabase, user);

    // Balance is checked against Quidax, never a local number.
    const wallets = await getSubAccountWallets(account.quidaxUserId);
    const wallet = wallets.find((w) => w.currency.toLowerCase() === fromAsset.toLowerCase());
    const available = Number(wallet?.balance ?? 0);
    if (!Number.isFinite(available) || available < cryptoAmount) {
      return json({ success: false, error: `Insufficient ${fromAsset} balance.` });
    }

    // Quidax's own live minimum for this pair surfaces as a real error here
    // (e.g. "Minimum TRX value should be above 3.02") rather than KaysPay
    // guessing one.
    let quote;
    try {
      quote = await createSwapQuotation({
        quidaxUserId: account.quidaxUserId,
        fromCurrency: fromAsset.toLowerCase(),
        toCurrency: toAsset.toLowerCase(),
        fromAmount: String(cryptoAmount),
      });
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      return json({ success: false, error: detail }, 400);
    }

    // Recorded BEFORE confirming -- confirming is the irreversible step (the
    // source coin is gone the instant it settles), same "record before the
    // irreversible step" discipline as Sell's own swap leg.
    const { data: txId, error: recordError } = await supabase.rpc("record_crypto_swap_pending", {
      p_user_id: user.id,
      p_from_asset: fromAsset,
      p_to_asset: toAsset,
      p_from_crypto_micro: cryptoMicro,
      p_swap_quotation_id: quote.id,
      p_idempotency_key: idempotencyKey,
    });
    if (recordError) {
      console.error("crypto-swap: could not record pending swap:", recordError.message);
      return json({ success: false, error: "Could not start the swap. Please try again." }, 500);
    }

    try {
      await confirmSwapQuotation({ quidaxUserId: account.quidaxUserId, quotationId: quote.id });
    } catch (e) {
      const failed = await supabase.rpc("fail_crypto_swap", { p_swap_quotation_id: quote.id, p_reason: "swap_confirm_failed" });
      const row = failed.data?.[0];
      if (row) await notifyCryptoSwapFailed(supabase, { userId: row.user_id, fromAsset: row.from_asset, toAsset: row.to_asset });
      const detail = e instanceof Error ? e.message : String(e);
      console.error("crypto-swap: confirm failed:", redactSecrets(detail));
      return json({ success: false, error: "Could not complete the swap. Please try again." }, 500);
    }

    return json({
      success: true,
      pending: true,
      transaction_id: txId,
      from_asset: fromAsset,
      to_asset: toAsset,
      crypto_micro: cryptoMicro,
      message: "Your swap is processing. You'll be notified once it completes.",
    });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.error("crypto-swap failed:", redactSecrets(detail));
    return json({ success: false, error: "Could not complete the swap. Please try again." }, 500);
  }
});
