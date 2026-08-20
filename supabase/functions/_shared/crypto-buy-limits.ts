import { getBuyLimits } from "./quidax-ramp-client.ts";

// Single source of truth for Buy's min/max — shared between crypto-buy
// (enforcement) and crypto-buy-limits (what the client displays), so the
// number shown on the amount-entry screen can never drift from what
// actually gets enforced when the purchase is submitted.

// Only used if Quidax's own limits endpoint is unreachable — their live
// values win, since breaching them fails the purchase only AFTER the
// customer has been shown an account to pay into.
export const FALLBACK_MIN_NGN = 3000;
export const FALLBACK_MAX_NGN = 2_000_000;

// Quidax's purchase_limits/buy endpoint reports a ₦2,000 minimum, but that's
// only the floor for STARTING a purchase — a real ₦2,790 purchase confirmed
// this the hard way: the deposit was accepted and a payment account issued,
// but the payout hung in "Processing" indefinitely and never completed.
// Quidax support confirmed (2026-08-20) the actual minimum for the trade
// their payout depends on to execute is ₦3,000 — not reflected in the
// limits endpoint at all. Enforced as an additional floor on top of
// whatever they report live, so their API's own number is never trusted
// below this regardless of what it says.
export const QUIDAX_MIN_TRADABLE_NGN = 3000;

export async function resolveBuyLimits(): Promise<{ minNgn: number; maxNgn: number }> {
  const limits = await getBuyLimits("ngn");
  return {
    minNgn: Math.max(limits?.min ?? FALLBACK_MIN_NGN, QUIDAX_MIN_TRADABLE_NGN),
    maxNgn: limits?.max ?? FALLBACK_MAX_NGN,
  };
}
