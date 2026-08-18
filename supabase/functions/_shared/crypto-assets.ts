// Curated set of coins Buy supports beyond USDT. Deliberately a small,
// hand-picked list rather than all ~50 assets Quidax's exchange trades —
// every entry here must be a coin Quidax's docs (docs.quidax.io/docs/
// supported-cryptocurrencies) mark "Send and Receive" capable, since a
// future manual-withdraw extension depends on that; several of Quidax's
// listed assets ("Cannot Send or Receive, Cannot create wallet address")
// are swap-only and are deliberately excluded.
//
// USDT is NOT in this list — it's handled as its own direct path in
// crypto-buy (Ramp delivers USDT straight from the purchase, no swap leg).
// Everything in SUPPORTED_SWAP_ASSETS goes through the two-leg buy: Ramp
// buys USDT into the customer's own Quidax sub-account, then that USDT is
// swapped for the target coin inside the same sub-account (see crypto-buy
// and crypto-quidax-webhook). It always lands in the customer's KaysPay
// crypto account — v1 does not offer external-wallet delivery for these
// (that would need a 3rd chained leg: buy -> swap -> withdraw), only USDT
// keeps today's direct-to-external-wallet option.
export interface SwapAsset {
  /** KaysPay/UI-facing code, uppercase. */
  code: string;
  /** Quidax's own currency code, lowercase — used in swap_quotation calls
   * and ticker market names. */
  quidaxCode: string;
  name: string;
}

export const SUPPORTED_SWAP_ASSETS: SwapAsset[] = [
  { code: "BTC", quidaxCode: "btc", name: "Bitcoin" },
  { code: "ETH", quidaxCode: "eth", name: "Ethereum" },
  { code: "SOL", quidaxCode: "sol", name: "Solana" },
  { code: "XRP", quidaxCode: "xrp", name: "Ripple" },
  { code: "TRX", quidaxCode: "trx", name: "Tron" },
  { code: "LTC", quidaxCode: "ltc", name: "Litecoin" },
  { code: "DOGE", quidaxCode: "doge", name: "Dogecoin" },
  { code: "ADA", quidaxCode: "ada", name: "Cardano" },
];

export function findSwapAsset(code: string): SwapAsset | undefined {
  const upper = code.trim().toUpperCase();
  return SUPPORTED_SWAP_ASSETS.find((a) => a.code === upper);
}
