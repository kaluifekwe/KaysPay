-- Adds '9psb' as a recognized provider value across the three places that
-- hardcode CHECK (provider IN ('paystack','flutterwave')) -- virtual_accounts
-- (090), funding_events (101), funding_compliance_holds (173). Zero behavior
-- change for existing paystack/flutterwave rows; without this the funding
-- path throws a constraint violation the first time a 9psb event is
-- recorded. funding_reconciliation_state (also 101) is deliberately left
-- untouched -- no periodic reconcile sweep exists or is being built for
-- 9PSB (no documented list-transactions endpoint to sweep against).

ALTER TABLE public.virtual_accounts DROP CONSTRAINT IF EXISTS virtual_accounts_provider_check;
ALTER TABLE public.virtual_accounts ADD CONSTRAINT virtual_accounts_provider_check
  CHECK (provider IN ('flutterwave', 'paystack', '9psb'));

ALTER TABLE public.funding_events DROP CONSTRAINT IF EXISTS funding_events_provider_check;
ALTER TABLE public.funding_events ADD CONSTRAINT funding_events_provider_check
  CHECK (provider IN ('paystack', 'flutterwave', '9psb'));

ALTER TABLE public.funding_compliance_holds DROP CONSTRAINT IF EXISTS funding_compliance_holds_provider_check;
ALTER TABLE public.funding_compliance_holds ADD CONSTRAINT funding_compliance_holds_provider_check
  CHECK (provider IN ('paystack', 'flutterwave', '9psb'));
