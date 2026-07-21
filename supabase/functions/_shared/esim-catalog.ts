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

// Buffer added on top of the raw interbank rate. The feed gives the official/
// interbank rate (~₦1,380); we actually buy USD nearer the parallel-market
// rate (~₦1,420), and the naira can move between daily updates. This buffer
// closes that gap plus a volatility cushion. Separate from ESIM_MARGIN_PERCENT
// (our profit) — this one only makes the conversion reflect real USD cost.
export const FX_BUFFER_PERCENT = 8;

// Our profit margin on top of the provider's own cost (Airalo's net price),
// applied when quoting the customer.
export const ESIM_MARGIN_PERCENT = 15;

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
  provider: "airalo" | "esimaccess";
  providerPackageId: string;
  name: string;
  dataMB: number | null; // null = unlimited
  days: number;
  priceUSD: number; // our cost from the provider
  priceKobo: number; // what we charge the customer (kobo)
}
