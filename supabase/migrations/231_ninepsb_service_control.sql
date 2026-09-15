-- Kill-switch entry for the whole 9PSB WAAS integration, same operational
-- pattern already used to disable/re-enable 'transfer' during a real past
-- incident (130/137). Inserted DISABLED, unlike every prior service_controls
-- row (which default enabled) -- this is new, unproven, real-money-adjacent
-- code and should require a conscious owner action via admin-service-controls
-- to switch on, not be live the moment this migration runs.

ALTER TABLE public.service_controls DROP CONSTRAINT IF EXISTS service_controls_service_check;
ALTER TABLE public.service_controls ADD CONSTRAINT service_controls_service_check
  CHECK (service IN ('vtu','esim','foreign_number','identity','nin_modification','transfer','crypto_withdraw','crypto','9psb_waas'));

INSERT INTO public.service_controls (service, enabled, reason)
VALUES ('9psb_waas', FALSE, 'New integration -- enable only after closed-testing verification steps pass')
ON CONFLICT (service) DO NOTHING;
