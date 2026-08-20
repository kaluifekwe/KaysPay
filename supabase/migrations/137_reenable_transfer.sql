-- Re-enables Wallet Transfer (owner decision, 2026-08-20).
--
-- Reverses migration 130. The blocker that parked it is fixed: outbound
-- calls to Flutterwave's payout API now route through a small authenticated
-- forward proxy with a fixed egress IP (infra/static-egress-proxy/, on
-- Fly.io), whitelisted on Flutterwave's dashboard — confirmed working with
-- a live end-to-end test through the proxy before this migration was
-- written. The second reason migration 130 gave (crypto sells paying out
-- directly via Quidax Ramp's off-ramp, making the wallet spend-only) was
-- never actually built — Sell still credits the in-app wallet — so general
-- wallet->bank withdrawal remains the only cash-out path and is needed.
UPDATE public.service_controls
   SET enabled = TRUE,
       reason = NULL,
       updated_at = now()
 WHERE service = 'transfer';
