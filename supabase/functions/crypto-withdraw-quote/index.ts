import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { adminClient, enforceRateLimit, getAuthUser, isDeviceSessionAllowed, readJsonBody, RequestBodyError } from "../_shared/auth.ts";
import { getOrCreateCryptoAccount } from "../_shared/crypto-account.ts";
import { getCryptoWithdrawalFee, getSubAccountWallets, isQuidaxConfigured } from "../_shared/quidax-client.ts";

// Same absolute floor as crypto-withdraw itself, and the same intent as
// crypto-buy's minimum: a flat 5 USDT floor made sense when every network
// cost about the same to withdraw on. It doesn't when TRC20 is $1, ERC20 is
// $2, and BEP20 is $0.02 for the identical send -- a 5 USDT ERC20 withdrawal
// loses 40% of itself to the fee, with nothing on screen ever warning it was
// coming. So the real minimum is computed live per network from Quidax's own
// fee, never hardcoded per network (that's exactly the belief that made
// crypto-buy default to TRC20 as "the cheapest network" when it was the
// second most expensive) -- capped so the fee can never exceed
// MAX_FEE_SHARE of what's being sent.
const MIN_USDT_FLOOR = 5;
const MAX_FEE_SHARE = 0.2;
const MAX_USDT = 2000;
const NETWORK_MAP: Record<string, string> = { TRC20: "trc20", ERC20: "erc20", BEP20: "bep20" };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders(), "Content-Type": "application/json" } });
}

serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;
  const user = await getAuthUser(req);
  if (!user) return json({ error: "Unauthorized" }, 401);
  if (!isQuidaxConfigured()) return json({ success: false, error: "Crypto service unavailable." }, 503);

  let body: { crypto_amount?: unknown; network?: unknown };
  try {
    body = await readJsonBody(req);
  } catch (error) {
    const e = error instanceof RequestBodyError ? error : new RequestBodyError(400, "Invalid request body");
    return json({ error: e.message }, e.status);
  }

  const network = String(body.network || "").toUpperCase();
  const quidaxNetwork = NETWORK_MAP[network];
  if (!quidaxNetwork) return json({ success: false, error: "Unsupported network" }, 400);

  const amount = Number(body.crypto_amount);
  if (!Number.isFinite(amount) || amount < MIN_USDT_FLOOR || amount > MAX_USDT) {
    return json({ success: false, error: `Enter an amount between ${MIN_USDT_FLOOR} and ${MAX_USDT} USDT.` }, 400);
  }

  const db = adminClient();
  if (!(await isDeviceSessionAllowed(req, db, user.id))) return json({ error: "Please log in again." }, 401);
  const rate = await enforceRateLimit(db, "crypto_withdraw_quote", user.id, 30, 300, user.id);
  if (!rate.allowed) return json({ success: false, error: "Too many checks. Please wait and try again." }, 429);

  try {
    const account = await getOrCreateCryptoAccount(db, user);
    const [wallets, feeRule] = await Promise.all([
      getSubAccountWallets(account.quidaxUserId),
      getCryptoWithdrawalFee({ currency: "usdt", amount, network: quidaxNetwork }),
    ]);
    const wallet = wallets.find((entry) => entry.currency.toLowerCase() === "usdt");
    const available = Number(wallet?.balance ?? 0);
    const fee = feeRule.fee;
    const totalRequired = amount + fee;
    // The real, network-specific minimum: whatever keeps the fee at or under
    // MAX_FEE_SHARE of the amount sent, never below the absolute floor.
    const minForNetwork = Math.max(MIN_USDT_FLOOR, fee / MAX_FEE_SHARE);
    return json({
      success: true,
      amount,
      network,
      network_fee: fee,
      fee_type: feeRule.type,
      fee_share_percent: amount > 0 ? Math.round((fee / amount) * 10000) / 100 : null,
      total_required: totalRequired,
      available,
      sufficient: Number.isFinite(available) && available + 1e-8 >= totalRequired,
      min_for_network: Math.round(minForNetwork * 1_000_000) / 1_000_000,
      max_withdraw: Math.max(0, Math.min(MAX_USDT, available - fee)),
      max_limit: MAX_USDT,
    });
  } catch {
    return json({ success: false, error: "Could not calculate the live network fee. Please try again." }, 503);
  }
});
