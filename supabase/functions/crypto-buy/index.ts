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
import { getUsdNgnRate } from "../_shared/esim-catalog.ts";
import { getMarketTicker } from "../_shared/quidax-client.ts";

// Buy: NGN wallet -> crypto balance. A pure internal ledger swap, no
// provider call at all — see migration 082's comment for why this can be
// fully live today even though crypto-withdraw can't be yet.
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const MIN_USD = 1;
const MAX_USD = 2000;

serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  const user = await getAuthUser(req);
  if (!user) return json({ error: "Unauthorized" }, 401);

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

  const rate = await enforceRateLimit(supabase, "crypto_buy", user.id, 20, 300, user.id);
  if (!rate.allowed) {
    return json({
      success: false,
      error: "Too many attempts. Please wait a few minutes and try again.",
      retry_after_seconds: rate.retryAfterSeconds,
    }, 429);
  }

  const asset = String(body.asset || "USDT");
  const usdAmount = Number(body.usd_amount);
  if (asset !== "USDT") {
    return json({ success: false, error: "Unsupported asset" }, 400);
  }
  if (!Number.isFinite(usdAmount) || usdAmount < MIN_USD || usdAmount > MAX_USD) {
    return json({ success: false, error: `Enter an amount between $${MIN_USD} and $${MAX_USD}` }, 400);
  }

  const authorized = await consumeAuthToken(supabase, user.id, body.auth_token);
  if (!authorized) {
    return json({ success: false, error: "Re-authorization required. Please try again." }, 401);
  }

  // Priced off Quidax's live USDT/NGN order book — specifically the ASK,
  // since that is what buying USDT actually costs. This used to use the
  // interbank USD/NGN feed built for eSIM pricing, a once-daily bank rate
  // sitting well below the real USDT market rate in Nigeria, which meant
  // every purchase sold USDT below market at KaysPay's expense. Falls back
  // to that feed only if the ticker is unreachable, so a price hiccup can't
  // break checkout.
  let fxRate: number;
  try {
    fxRate = (await getMarketTicker("usdtngn")).ask;
  } catch (e) {
    console.error("crypto-buy: Quidax ticker failed, falling back to FX feed:", e instanceof Error ? e.message : e);
    fxRate = await getUsdNgnRate(supabase);
  }
  const ngnKobo = Math.round(usdAmount * fxRate * 100);
  // USDT is dollar-pegged 1:1 — the amount bought equals the USD entered.
  const cryptoMicro = Math.round(usdAmount * 1_000_000);
  const idempotencyKey = String(body.idempotency_key || `crypto_buy_${user.id}_${Date.now()}`);

  const { data: txId, error } = await supabase.rpc("buy_crypto", {
    p_user_id: user.id,
    p_asset: asset,
    p_ngn_kobo: ngnKobo,
    p_crypto_micro: cryptoMicro,
    p_rate: fxRate,
    p_idempotency_key: idempotencyKey,
  });

  if (error) {
    const msg = error.message || "";
    if (msg.includes("INSUFFICIENT_FUNDS")) {
      return json({ success: false, error: "Insufficient wallet balance" });
    }
    if (msg.includes("WALLET_NOT_FOUND")) {
      return json({ success: false, error: "Wallet not found" });
    }
    return json({ success: false, error: "Could not complete the purchase. Please try again." }, 500);
  }

  return json({
    success: true,
    transaction_id: txId,
    asset,
    crypto_micro: cryptoMicro,
    ngn_kobo: ngnKobo,
    rate: fxRate,
  });
});
