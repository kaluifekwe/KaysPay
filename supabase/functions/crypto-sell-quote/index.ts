import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { adminClient, enforceRateLimit, getAuthUser, isDeviceSessionAllowed, readJsonBody, RequestBodyError } from "../_shared/auth.ts";
import { getOrCreateCryptoAccount } from "../_shared/crypto-account.ts";
import { createSwapQuotation, getCryptoWithdrawalFee, getSubAccountWallets, isQuidaxConfigured } from "../_shared/quidax-client.ts";
import { getSellQuote } from "../_shared/quidax-ramp-client.ts";

const MIN_USDT = 1;
const MAX_USDT = 2000;
const SUPPORTED_ASSETS = ["USDT", "BTC", "ETH", "SOL", "XRP", "TRX", "LTC", "DOGE", "ADA"];
// Must match crypto-sell's OFFRAMP_USDT_NETWORK — this quote is what the
// customer is shown before confirming, so a mismatch would quote one fee
// and charge another. See the note there: BEP20 costs $0.02 against
// TRC20's $1.00.
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

  let body: { asset?: unknown; crypto_amount?: unknown };
  try {
    body = await readJsonBody(req);
  } catch (error) {
    const e = error instanceof RequestBodyError ? error : new RequestBodyError(400, "Invalid request body");
    return json({ error: e.message }, e.status);
  }

  const asset = String(body.asset || "USDT").toUpperCase();
  const amount = Number(body.crypto_amount);
  if (!SUPPORTED_ASSETS.includes(asset)) return json({ success: false, error: "Unsupported asset" }, 400);
  if (!Number.isFinite(amount) || amount <= 0) return json({ success: false, error: "Enter a valid amount." }, 400);
  if (asset === "USDT" && (amount < MIN_USDT || amount > MAX_USDT)) {
    return json({ success: false, error: `Enter an amount between ${MIN_USDT} and ${MAX_USDT} USDT.` }, 400);
  }

  const db = adminClient();
  if (!(await isDeviceSessionAllowed(req, db, user.id))) return json({ error: "Please log in again." }, 401);
  const rate = await enforceRateLimit(db, "crypto_sell_quote", user.id, 30, 300, user.id);
  if (!rate.allowed) return json({ success: false, error: "Too many checks. Please wait and try again." }, 429);

  try {
    const account = await getOrCreateCryptoAccount(db, user);
    const wallets = await getSubAccountWallets(account.quidaxUserId);
    const wallet = wallets.find((entry) => entry.currency.toLowerCase() === asset.toLowerCase());
    const available = Number(wallet?.balance ?? 0);

    // Non-USDT: this is a preview of the SAME swap the real sale will
    // request (and separately confirm) right before committing -- quotes
    // are read-only and cost nothing, so requesting one here just to show
    // the customer an estimate is safe. Quidax's own live minimum for this
    // asset surfaces as a real error here (e.g. "Minimum TRX value should
    // be above 3.02") rather than KaysPay guessing one.
    let usdtEquivalent = amount;
    if (asset !== "USDT") {
      try {
        const quote = await createSwapQuotation({
          quidaxUserId: account.quidaxUserId,
          fromCurrency: asset.toLowerCase(),
          toCurrency: "usdt",
          fromAmount: String(amount),
        });
        usdtEquivalent = Number(quote.toAmount);
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        return json({ success: false, error: detail }, 400);
      }
    }

    const [feeRule, sellQuote] = await Promise.all([
      getCryptoWithdrawalFee({ currency: "usdt", amount: usdtEquivalent, network: NETWORK }),
      // Quidax's own figure for what actually lands in the bank, rather than
      // the client multiplying a market rate and hoping. Resolves to null on
      // any failure, and the client keeps its rate-based estimate — a quote
      // outage must never block a sale.
      getSellQuote({ token: "usdt", currency: "ngn", tokenAmount: usdtEquivalent, network: NETWORK }),
    ]);
    const fee = feeRule.fee;
    // For USDT the fee is charged ON TOP of what's sold, so the balance
    // must cover both. For a swap-sourced sale the fee comes out of the
    // USDT the swap itself produces (nothing more is taken from the
    // customer's source-coin balance beyond `amount`) -- so the balance
    // check below is against `amount` in the source asset either way, and
    // "total_required" in USDT terms is only meaningful for the USDT case.
    const totalRequiredUsdt = asset === "USDT" ? amount + fee : usdtEquivalent;
    const sufficientBalance = Number.isFinite(available) && available + 1e-8 >= amount;
    const sufficientAfterFee = asset === "USDT"
      ? Number.isFinite(available) && available + 1e-8 >= totalRequiredUsdt
      : usdtEquivalent > fee;

    return json({
      success: true,
      asset,
      amount,
      network: NETWORK,
      network_fee: fee,
      fee_type: feeRule.type,
      total_required: totalRequiredUsdt,
      usdt_equivalent: asset === "USDT" ? null : usdtEquivalent,
      // Naira the customer actually receives, from Quidax, net of their
      // processor fee. Null when the quote could not be read.
      expected_ngn: sellQuote?.toAmount ?? null,
      processor_fee_ngn: sellQuote?.fee ?? null,
      available,
      sufficient: sufficientBalance && sufficientAfterFee,
      max_sell: asset === "USDT" ? Math.max(0, Math.min(MAX_USDT, available - fee)) : available,
      min_sell: asset === "USDT" ? MIN_USDT : null,
      max_limit: asset === "USDT" ? MAX_USDT : null,
    });
  } catch {
    return json({ success: false, error: "Could not calculate the live network fee. Please try again." }, 503);
  }
});
