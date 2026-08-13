import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import {
  adminClient,
  consumeAuthToken,
  enforceRateLimit,
  getAuthUser,
  isDeviceSessionAllowed,
  readJsonBody,
  RequestBodyError,
} from "../_shared/auth.ts";
import { getOrCreateCryptoAccount } from "../_shared/crypto-account.ts";
import {
  confirmSwapQuotation,
  createSwapQuotation,
  getSubAccountWallets,
  isQuidaxConfigured,
} from "../_shared/quidax-client.ts";

// Sell: swaps USDT held in the user's OWN Quidax sub-account into NGN, then
// credits their KaysPay Naira wallet once Quidax confirms the swap settled.
// Nothing is debited from a local crypto ledger — Quidax is the source of
// truth for what the user holds (see migration 119).
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const MIN_USDT = 1;
const MAX_USDT = 2000;

serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  const user = await getAuthUser(req);
  if (!user) return json({ error: "Unauthorized" }, 401);

  if (!isQuidaxConfigured()) {
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

  const asset = String(body.asset || "USDT");
  const cryptoAmount = Number(body.crypto_amount);
  if (asset !== "USDT") {
    return json({ success: false, error: "Unsupported asset" }, 400);
  }
  if (!Number.isFinite(cryptoAmount) || cryptoAmount < MIN_USDT || cryptoAmount > MAX_USDT) {
    return json({ success: false, error: `Enter an amount between ${MIN_USDT} and ${MAX_USDT} USDT` }, 400);
  }

  const authorized = await consumeAuthToken(supabase, user.id, body.auth_token);
  if (!authorized) {
    return json({ success: false, error: "Re-authorization required. Please try again." }, 401);
  }

  const idempotencyKey = String(body.idempotency_key || `crypto_sell_${user.id}_${Date.now()}`);
  const cryptoMicro = Math.round(cryptoAmount * 1_000_000);

  try {
    const account = await getOrCreateCryptoAccount(supabase, user);

    // Balance is checked against Quidax, never a local number — a stale
    // local copy could authorize a sale the user can't actually cover.
    const wallets = await getSubAccountWallets(account.quidaxUserId);
    const usdt = wallets.find((w) => w.currency.toLowerCase() === "usdt");
    const available = Number(usdt?.balance ?? 0);
    if (!Number.isFinite(available) || available < cryptoAmount) {
      return json({ success: false, error: "Insufficient USDT balance." });
    }

    // Quotes expire in ~15 seconds, so quote -> record -> confirm runs
    // back to back with nothing slow in between.
    const quotation = await createSwapQuotation({
      quidaxUserId: account.quidaxUserId,
      fromCurrency: "usdt",
      toCurrency: "ngn",
      fromAmount: String(cryptoAmount),
    });

    const quotedNgnKobo = Math.round(Number(quotation.toAmount) * 100);
    if (!Number.isSafeInteger(quotedNgnKobo) || quotedNgnKobo <= 0) {
      return json({ success: false, error: "Could not price this sale right now. Please try again." });
    }

    // Recorded BEFORE confirming, so an irreversible swap can never happen
    // without a row for the webhook to settle against.
    const { data: txId, error: recordError } = await supabase.rpc("record_crypto_sell_pending", {
      p_user_id: user.id,
      p_asset: asset,
      p_crypto_micro: cryptoMicro,
      p_swap_id: quotation.id,
      p_quoted_ngn_kobo: quotedNgnKobo,
      p_idempotency_key: idempotencyKey,
    });
    if (recordError) {
      console.error("crypto-sell: could not record pending sale:", recordError.message);
      return json({ success: false, error: "Could not start the sale. Please try again." }, 500);
    }

    try {
      await confirmSwapQuotation({
        quidaxUserId: account.quidaxUserId,
        quotationId: quotation.id,
      });
    } catch (confirmError) {
      await supabase.rpc("fail_crypto_sell", {
        p_swap_id: quotation.id,
        p_reason: "confirm_failed",
      });
      const detail = confirmError instanceof Error ? confirmError.message : String(confirmError);
      console.error("crypto-sell: confirm failed:", detail);
      return json({ success: false, error: "The rate expired before this went through. Please try again." });
    }

    return json({
      success: true,
      pending: true,
      transaction_id: txId,
      asset,
      crypto_micro: cryptoMicro,
      ngn_kobo: quotedNgnKobo,
      message: "Your sale is processing. Your wallet is credited the moment it settles.",
    });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.error("crypto-sell failed:", detail);
    return json({ success: false, error: "Could not complete the sale. Please try again." }, 500);
  }
});
