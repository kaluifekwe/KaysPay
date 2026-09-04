import { getBuyLimits } from "./quidax-ramp-client.ts";

// Single source of truth for Buy's min/max — shared between crypto-buy
// (enforcement) and crypto-buy-limits (what the client displays), so the
// number shown on the amount-entry screen can never drift from what
// actually gets enforced when the purchase is submitted.

// Only used if Quidax's own limits endpoint is unreachable — their live
// values win, since breaching them fails the purchase only AFTER the
// customer has been shown an account to pay into.
export const FALLBACK_MIN_NGN = 10000;
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
//
// History: briefly raised to ₦10,000 on 2026-08-31 as a stopgap (see below),
// then dropped back to ₦3,000 on the same day once delivery moved to BEP20
// and the fee problem that justified it was actually fixed. Raised to
// ₦10,000 again on 2026-09-05 — this time as a deliberate owner decision on
// minimum order size, not a fee workaround; the BEP20 fix below still holds,
// so a ₦3,000 purchase would deliver its full value today if allowed.
//
// Quidax explained that the ₦2,790 order hung because TRC20 gas is a flat $1
// and the order was worth 0.9963 USDT — less than the fee to move it. They
// also confirmed that money is never returned ("it remains in that state").
// Being a FLAT fee, it hit small orders hardest: measured across every
// completed buy the gap between gross and delivered was $1.00–$1.08 every
// time, so a ₦3,000 purchase delivered barely half its value under TRC20.
//
// crypto-buy was settling on TRC20 in the belief that it was the cheapest
// network; Quidax's own fee table shows it is joint most expensive at $1.00,
// while BEP20 is $0.02. Delivery moved to BEP20, so that fee is now two
// cents and no longer a reason to keep the floor above ₦3,000 on its own.
//
// The ₦3,000 (not ₦2,000, which Quidax's limits endpoint reports) floor
// remains the documented hard minimum for the underlying trade to execute at
// all, confirmed by Quidax support (2026-08-20) — their API's own figure is
// still never trusted below this, independent of the ₦10,000 order-size
// floor above it.
export const QUIDAX_MIN_TRADABLE_NGN = 10000;

export async function resolveBuyLimits(): Promise<{ minNgn: number; maxNgn: number }> {
  const limits = await getBuyLimits("ngn");
  return {
    minNgn: Math.max(limits?.min ?? FALLBACK_MIN_NGN, QUIDAX_MIN_TRADABLE_NGN),
    maxNgn: limits?.max ?? FALLBACK_MAX_NGN,
  };
}
