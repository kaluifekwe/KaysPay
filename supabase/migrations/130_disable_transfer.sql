-- Switches Wallet Transfer OFF (owner decision, 2026-08-18).
--
-- Two reasons it's being parked rather than finished:
--  1. Flutterwave's payout API requires IP whitelisting, and Supabase Edge
--     Functions cannot provide static egress IPs (confirmed in Supabase's
--     own docs), so the send leg cannot complete from where it runs today.
--  2. More importantly, the architecture it existed to serve has changed:
--     crypto sells will pay naira DIRECTLY to the customer's bank via
--     Quidax Ramp's off-ramp, never entering the KaysPay wallet. The wallet
--     becomes spend-only (airtime/data/TV/bills/exam pins/eSIM), so there
--     is no longer a wallet->bank cash-out path that needs building.
--
-- The feature's code, RPCs and edge functions are intentionally left in
-- place rather than deleted: if a general wallet->bank withdrawal is ever
-- wanted, re-enabling is a single row update (or the admin Service Controls
-- screen, which now lists 'transfer' — see the companion change to
-- admin-service-controls). Keeping it switched off costs nothing, and
-- transfer-send checks isServiceEnabled('transfer') before touching money.
UPDATE public.service_controls
   SET enabled = FALSE,
       reason = 'Parked: crypto sells will pay out directly via Quidax Ramp off-ramp; wallet is spend-only. Flutterwave payouts also blocked by static-IP whitelisting.',
       updated_at = now()
 WHERE service = 'transfer';
