import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { adminClient, enforceRateLimit, getAuthUser, isDeviceSessionAllowed, readJsonBody, RequestBodyError } from "../_shared/auth.ts";
import { getOrCreateCryptoAccount } from "../_shared/crypto-account.ts";
import { getCryptoWithdrawalFee, getSubAccountWallets, isQuidaxConfigured } from "../_shared/quidax-client.ts";
import { DUST_FLOOR, maxWithdrawInAssetUnits, resolveWithdrawTarget } from "../_shared/crypto-withdraw-assets.ts";

// The real minimum is always computed live per network from Quidax's own
// fee, never hardcoded per network/asset (that's exactly the belief that
// made crypto-buy default to TRC20 as "the cheapest network" when it was
// the second most expensive) -- capped so the fee can never exceed
// MAX_FEE_SHARE of what's being sent. See _shared/crypto-withdraw-assets.ts
// for the per-asset dust floor and USDT-equivalent max.
const MAX_FEE_SHARE = 0.2;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders(), "Content-Type": "application/json" } });
}

serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;
  const user = await getAuthUser(req);
  if (!user) return json({ error: "Unauthorized" }, 401);
  if (!isQuidaxConfigured()) return json({ success: false, error: "Crypto service unavailable." }, 503);

  let body: { asset?: unknown; crypto_amount?: unknown; network?: unknown };
  try {
    body = await readJsonBody(req);
  } catch (error) {
    const e = error instanceof RequestBodyError ? error : new RequestBodyError(400, "Invalid request body");
    return json({ error: e.message }, e.status);
  }

  const target = resolveWithdrawTarget(String(body.asset || "USDT"), String(body.network || ""));
  if (!target) return json({ success: false, error: "Unsupported asset or network" }, 400);
  const { asset, networkLabel, config } = target;
  const dustFloor = DUST_FLOOR[asset] ?? DUST_FLOOR.USDT;

  const amount = Number(body.crypto_amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return json({ success: false, error: "Enter a valid amount." }, 400);
  }

  const db = adminClient();
  if (!(await isDeviceSessionAllowed(req, db, user.id))) return json({ error: "Please log in again." }, 401);
  const rate = await enforceRateLimit(db, "crypto_withdraw_quote", user.id, 30, 300, user.id);
  if (!rate.allowed) return json({ success: false, error: "Too many checks. Please wait and try again." }, 429);

  try {
    const account = await getOrCreateCryptoAccount(db, user);
    const [wallets, feeRule, maxWithdraw] = await Promise.all([
      getSubAccountWallets(account.quidaxUserId),
      getCryptoWithdrawalFee({ currency: config.quidaxCurrency, amount, network: config.quidaxNetwork }),
      maxWithdrawInAssetUnits(config.quidaxCurrency),
    ]);
    if (amount > maxWithdraw) {
      return json({ success: false, error: `Enter an amount up to ${maxWithdraw.toFixed(8).replace(/0+$/, "").replace(/\.$/, "")} ${asset}.` }, 400);
    }
    const wallet = wallets.find((entry) => entry.currency.toLowerCase() === config.quidaxCurrency);
    const available = Number(wallet?.balance ?? 0);
    const fee = feeRule.fee;
    const totalRequired = amount + fee;
    // The real, network-specific minimum: whatever keeps the fee at or under
    // MAX_FEE_SHARE of the amount sent, never below the asset's dust floor.
    const minForNetwork = Math.max(dustFloor, fee / MAX_FEE_SHARE);
    return json({
      success: true,
      asset,
      amount,
      network: networkLabel,
      network_fee: fee,
      fee_type: feeRule.type,
      fee_share_percent: amount > 0 ? Math.round((fee / amount) * 10000) / 100 : null,
      total_required: totalRequired,
      available,
      sufficient: Number.isFinite(available) && available + 1e-8 >= totalRequired,
      min_for_network: Math.round(minForNetwork * 1e8) / 1e8,
      max_withdraw: Math.max(0, Math.min(maxWithdraw, available - fee)),
      max_limit: maxWithdraw,
    });
  } catch {
    return json({ success: false, error: "Could not calculate the live network fee. Please try again." }, 503);
  }
});
