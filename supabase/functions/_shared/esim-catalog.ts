// Travel eSIM pricing — NGN conversion happens server-side since both
// providers price in USD. This rate is a manually-set snapshot, not a live
// feed (same limitation already true of every other catalog in this app —
// see kayspay-progress notes on stale pricing risk). Revisit periodically.
export const USD_TO_NGN_RATE = 1600;

// Our margin on top of the provider's own cost (Airalo's net_price / eSIM
// Access's price), applied when quoting the customer.
export const ESIM_MARGIN_PERCENT = 15;

export function usdToNgnKobo(usd: number): number {
  return Math.round(usd * USD_TO_NGN_RATE * (1 + ESIM_MARGIN_PERCENT / 100) * 100);
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
