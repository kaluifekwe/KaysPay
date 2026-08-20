-- Kill switch for crypto Withdraw (crypto -> external wallet address), same
-- shape as migration 128's Transfer switch and 113's identity/nin_modification
-- split. Owner decision, 2026-08-20: not important enough to keep visible
-- given Buy/Sell now cover the core Naira<->crypto need — turned off rather
-- than removed, so it can come back with a single row update if ever wanted.
ALTER TABLE public.service_controls DROP CONSTRAINT IF EXISTS service_controls_service_check;
ALTER TABLE public.service_controls ADD CONSTRAINT service_controls_service_check
  CHECK (service IN ('vtu','esim','foreign_number','identity','nin_modification','transfer','crypto_withdraw'));

INSERT INTO public.service_controls(service, enabled, reason)
VALUES ('crypto_withdraw', FALSE, 'Parked: Buy/Sell cover the core Naira<->crypto need; external-wallet withdraw kept but hidden as a lower-priority feature (owner decision 2026-08-20).')
ON CONFLICT (service) DO UPDATE SET enabled = FALSE, reason = EXCLUDED.reason, updated_at = now();
