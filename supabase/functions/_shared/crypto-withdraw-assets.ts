// Per-asset withdrawal config, shared by crypto-withdraw and
// crypto-withdraw-quote so the two can never drift apart on what they
// validate/quote vs what actually gets sent.
//
// USDT keeps its existing multi-network shape (the customer picks TRC20/
// ERC20/BEP20 -- real fee differs a lot per chain). Every other supported
// asset withdraws over its one real chain, confirmed against Quidax's own
// SDK example rather than guessed (createWithdrawal(userId, 'btc', amount,
// address, 'btc') -- the network param for a single-chain asset is the
// asset's own Quidax currency code, not 'none' as their wallet-address
// docs use for a *different* endpoint).
//
// Address patterns are each a stable, protocol-level standard (not
// Quidax-specific, so not something that changes per provider):
//   BTC  -- legacy P2PKH (1...), P2SH (3...), native SegWit/Taproot bech32
//           (bc1...) -- BIP13/16/173/350.

import { getMarketTicker } from "./quidax-client.ts";

export interface AssetNetworkConfig {
  /** Quidax's own currency code for wallet/fee/withdrawal calls. */
  quidaxCurrency: string;
  /** Quidax's own network code for the withdrawal call itself. */
  quidaxNetwork: string;
  addressPattern: RegExp;
}

export const USDT_NETWORKS: Record<string, AssetNetworkConfig> = {
  TRC20: { quidaxCurrency: "usdt", quidaxNetwork: "trc20", addressPattern: /^T[1-9A-HJ-NP-Za-km-z]{33}$/ },
  ERC20: { quidaxCurrency: "usdt", quidaxNetwork: "erc20", addressPattern: /^0x[a-fA-F0-9]{40}$/ },
  BEP20: { quidaxCurrency: "usdt", quidaxNetwork: "bep20", addressPattern: /^0x[a-fA-F0-9]{40}$/ },
};

// Assets withdrawn over their own single native chain -- extended one at a
// time (BTC first), each verified against Quidax before being added here.
export const SINGLE_NETWORK_ASSETS: Record<string, AssetNetworkConfig> = {
  BTC: {
    quidaxCurrency: "btc",
    quidaxNetwork: "btc",
    addressPattern: /^(1[a-km-zA-HJ-NP-Z1-9]{25,34}|3[a-km-zA-HJ-NP-Z1-9]{25,34}|bc1[a-z0-9]{25,90})$/,
  },
};

export interface ResolvedWithdrawTarget {
  asset: string;
  /** What to show/store as the "network" — the chosen chain for USDT,
   * the asset's own name for a single-network asset (there's nothing to
   * choose, so nothing to show as a separate field). */
  networkLabel: string;
  config: AssetNetworkConfig;
}

/**
 * Resolves { asset, network } from a request into real Quidax params and an
 * address pattern, covering both USDT's multi-network case and every
 * single-network asset. Returns null for anything unsupported so callers
 * can give one consistent "Unsupported asset/network" response.
 */
export function resolveWithdrawTarget(asset: string, network: string): ResolvedWithdrawTarget | null {
  const upperAsset = asset.trim().toUpperCase();
  if (upperAsset === "USDT") {
    const upperNetwork = network.trim().toUpperCase();
    const config = USDT_NETWORKS[upperNetwork];
    if (!config) return null;
    return { asset: upperAsset, networkLabel: upperNetwork, config };
  }
  const config = SINGLE_NETWORK_ASSETS[upperAsset];
  if (!config) return null;
  return { asset: upperAsset, networkLabel: upperAsset, config };
}

// USDT's own long-standing per-withdrawal ceiling. Every other asset uses
// the live USDT-equivalent value of the same ceiling (via a real market
// rate) rather than a separate guessed number per asset, so the actual
// risk/compliance limit this represents stays consistent across assets.
export const MAX_USDT_EQUIVALENT = 2000;
// Absolute dust floor only, per asset — the real minimum is always the
// live fee-based one computed by the caller (fee / MAX_FEE_SHARE); this
// just guards against a degenerate near-zero fee response. USDT keeps its
// original literal-5 floor unchanged; BTC's is priced in BTC, not USDT, so
// reusing "5" would be nonsensical (five bitcoin).
export const DUST_FLOOR: Record<string, number> = {
  USDT: 5,
  BTC: 0.0001,
};

/**
 * Converts MAX_USDT_EQUIVALENT into the target asset's own units using a
 * live market rate. USDT needs no conversion. Throws if the rate can't be
 * fetched — callers should surface that as a real error, never fall back
 * to a guessed number for a financial ceiling.
 */
export async function maxWithdrawInAssetUnits(quidaxCurrency: string): Promise<number> {
  if (quidaxCurrency === "usdt") return MAX_USDT_EQUIVALENT;
  const ticker = await getMarketTicker(`${quidaxCurrency}usdt`);
  return MAX_USDT_EQUIVALENT / ticker.last;
}
