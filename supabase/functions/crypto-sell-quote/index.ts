import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { adminClient, enforceRateLimit, getAuthUser, isDeviceSessionAllowed, readJsonBody, RequestBodyError } from "../_shared/auth.ts";
import { getOrCreateCryptoAccount } from "../_shared/crypto-account.ts";
import { getCryptoWithdrawalFee, getSubAccountWallets, isQuidaxConfigured } from "../_shared/quidax-client.ts";

const MIN_USDT = 1;
const MAX_USDT = 2000;
// Must match crypto-sell's USDT_NETWORK — this quote is what the customer is
// shown before confirming, so a mismatch would quote one fee and charge
// another. See the note there: BEP20 costs $0.02 against TRC20's $1.00.
const NETWORK = "bep20";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders(), "Content-Type": "application/json" } });
}

serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;
  const user = await getAuthUser(req);
  if (!user) return json({ error: "Unauthorized" }, 401);
  if (!isQuidaxConfigured()) return json({ success: false, error: "Crypto service unavailable." }, 503);

  let body: { crypto_amount?: unknown };
  try {
    body = await readJsonBody(req);
  } catch (error) {
    const e = error instanceof RequestBodyError ? error : new RequestBodyError(400, "Invalid request body");
    return json({ error: e.message }, e.status);
  }

  const amount = Number(body.crypto_amount);
  if (!Number.isFinite(amount) || amount < MIN_USDT || amount > MAX_USDT) {
    return json({ success: false, error: `Enter an amount between ${MIN_USDT} and ${MAX_USDT} USDT.` }, 400);
  }

  const db = adminClient();
  if (!(await isDeviceSessionAllowed(req, db, user.id))) return json({ error: "Please log in again." }, 401);
  const rate = await enforceRateLimit(db, "crypto_sell_quote", user.id, 30, 300, user.id);
  if (!rate.allowed) return json({ success: false, error: "Too many checks. Please wait and try again." }, 429);

  try {
    const account = await getOrCreateCryptoAccount(db, user);
    const [wallets, feeRule] = await Promise.all([
      getSubAccountWallets(account.quidaxUserId),
      getCryptoWithdrawalFee({ currency: "usdt", amount, network: NETWORK }),
    ]);
    const wallet = wallets.find((entry) => entry.currency.toLowerCase() === "usdt");
    const available = Number(wallet?.balance ?? 0);
    const fee = feeRule.fee;
    const totalRequired = amount + fee;
    return json({
      success: true,
      amount,
      network: NETWORK,
      network_fee: fee,
      fee_type: feeRule.type,
      total_required: totalRequired,
      available,
      sufficient: Number.isFinite(available) && available + 1e-8 >= totalRequired,
      max_sell: Math.max(0, Math.min(MAX_USDT, available - fee)),
      min_sell: MIN_USDT,
      max_limit: MAX_USDT,
    });
  } catch {
    return json({ success: false, error: "Could not calculate the live network fee. Please try again." }, 503);
  }
});
