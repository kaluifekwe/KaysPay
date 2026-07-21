import { adminClient } from "./auth.ts";

// Travel eSIM pricing — providers price in USD, we charge in NGN, so the USD→
// NGN conversion happens server-side.
//
// The rate is now a LIVE daily value stored in the `fx_rates` table (pair
// 'USD_NGN'), refreshed by the `fx-sync` cron from a public interbank feed
// (open.er-api.com). The constant below is ONLY a fallback, used if that row
// is missing or the DB read fails, so a feed/DB hiccup can never break
// checkout. Keep it roughly current.
export const DEFAULT_USD_TO_NGN_RATE = 1450;

// Buffer on top of the raw interbank rate, to cover the gap up to the
// parallel-market rate we actually buy USD at (~₦1,420 vs ~₦1,380 interbank)
// plus naira volatility between daily updates. Separate from
// ESIM_MARGIN_PERCENT (profit) — this only makes the conversion reflect real
// USD cost. Set to 0 by owner (2026-07-20): pricing is now the plain interbank
// rate + margin. NOTE: while the parallel premium stays under the 15% margin
// this is still profitable, but a sharp naira drop could erode it — raise this
// again to re-add a cushion.
export const FX_BUFFER_PERCENT = 0;

// Profit margin on top of the provider's net price. Set to 0 by owner
// (2026-07-20). Combined with FX_BUFFER_PERCENT = 0, eSIMs now sell at the raw
// interbank rate — which is BELOW the parallel-market rate USD is actually
// bought at — so each sale currently runs at a small loss. This is a
// deliberate owner decision, NOT a bug; raise this value to restore profit.
export const ESIM_MARGIN_PERCENT = 0;

/**
 * Reads the live USD→NGN interbank rate from `fx_rates`. Falls back to
 * DEFAULT_USD_TO_NGN_RATE if the row is missing, zero, or unreadable — a feed
 * or DB problem must never break pricing/checkout.
 */
export async function getUsdNgnRate(supabase: ReturnType<typeof adminClient>): Promise<number> {
  try {
    const { data } = await supabase
      .from("fx_rates")
      .select("rate")
      .eq("pair", "USD_NGN")
      .maybeSingle();
    const rate = Number(data?.rate);
    if (Number.isFinite(rate) && rate > 0) return rate;
  } catch {
    // fall through to the default
  }
  return DEFAULT_USD_TO_NGN_RATE;
}

/**
 * Convert a USD provider price into the kobo amount we charge the customer:
 * interbank `rate` → +FX buffer (real USD cost) → +profit margin → kobo.
 * `rate` should come from getUsdNgnRate(); it defaults to the fallback so the
 * function stays safe if ever called without one.
 */
export function usdToNgnKobo(usd: number, rate: number = DEFAULT_USD_TO_NGN_RATE): number {
  return Math.round(
    usd * rate * (1 + FX_BUFFER_PERCENT / 100) * (1 + ESIM_MARGIN_PERCENT / 100) * 100,
  );
}

export interface NormalizedEsimPlan {
  id: string; // opaque `${provider}:${providerPackageId}` — echoed back for purchase
  provider: "airalo";
  providerPackageId: string;
  name: string;
  dataMB: number | null; // null = unlimited
  days: number;
  priceUSD: number; // our cost from the provider
  priceKobo: number; // what we charge the customer (kobo)
}
