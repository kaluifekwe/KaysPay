-- 145_crypto_visibility_kill_switch.sql
--
-- Owner wants a single admin toggle that hides Crypto Buy/Sell from the app
-- entirely (not the "coming soon" placeholder it showed before — genuinely
-- absent from the Home screen), not just the already-separate crypto_withdraw
-- switch. Same shape as every other service_controls addition (061, 113, 128,
-- 141). Defaults to enabled=TRUE so nothing changes until the owner actually
-- toggles it off in the admin panel.
ALTER TABLE public.service_controls DROP CONSTRAINT IF EXISTS service_controls_service_check;
ALTER TABLE public.service_controls ADD CONSTRAINT service_controls_service_check
  CHECK (service IN ('vtu','esim','foreign_number','identity','nin_modification','transfer','crypto_withdraw','crypto'));

INSERT INTO public.service_controls(service, enabled, reason)
VALUES ('crypto', TRUE, NULL)
ON CONFLICT (service) DO NOTHING;

-- service_controls itself stays locked down to service_role (admin edge
-- functions + server-side kill-switch checks) — see migration 061. The app
-- still needs SOME way to know whether to show the Crypto tile at all, so
-- this adds a narrow, purpose-built read surface: it only ever answers for
-- services explicitly whitelisted in its body (just 'crypto' today), never
-- exposes the reason/updated_at admin metadata, and never becomes a general
-- window into service_controls just because a new row gets added there.
CREATE OR REPLACE FUNCTION public.is_client_feature_enabled(p_service TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE WHEN p_service = ANY (ARRAY['crypto'])
    THEN COALESCE((SELECT enabled FROM service_controls WHERE service = p_service), FALSE)
    ELSE FALSE
  END;
$$;

REVOKE ALL ON FUNCTION public.is_client_feature_enabled(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_client_feature_enabled(TEXT) TO authenticated;
