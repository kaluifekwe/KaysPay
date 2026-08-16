// Yellow Card — the intended crypto on/off-ramp provider once their merchant
// API access is approved (the same approval process the Yellow Card
// compliance documents earlier in this project were prepared for). Nothing
// about their actual API (auth, endpoints, field names) is confirmed yet —
// this file is a placeholder ONLY, mirroring the shape of every other
// provider client here (_shared/paystack-client.ts, _shared/flutterwave-
// client.ts) so real implementation is a same-file swap once real docs/
// sandbox access exist, following the exact discipline used for every other
// provider integration in this codebase: no guessed endpoint shapes ever
// ship, real docs/live responses come first.
//
// Buy/sell (crypto-buy, crypto-sell) never call this file at all — they're
// pure internal wallet<->crypto-balance ledger swaps with no provider
// involved. Only crypto-withdraw (a real on-chain broadcast to an external
// wallet) needs this, and it refuses to run while isYellowCardConfigured()
// is false — see crypto-withdraw/index.ts.
const YELLOWCARD_API_KEY = Deno.env.get("YELLOWCARD_API_KEY");

export class YellowCardError extends Error {}

export function isYellowCardConfigured(): boolean {
  return !!YELLOWCARD_API_KEY;
}

/**
 * Broadcasts a crypto withdrawal to an external wallet address. Not
 * implemented — isYellowCardConfigured() is false until real credentials
 * and API docs exist, so this should never actually be reached; it throws
 * defensively if it somehow is.
 */
export async function broadcastCryptoWithdrawal(
  _params: { asset: string; network: string; address: string; amountMicro: number },
): Promise<{ success: boolean; providerRef: string | null }> {
  throw new YellowCardError("Yellow Card integration not yet implemented");
}
