-- Kay's Pay: expose "does the caller already have a PIN?" to the client.
-- =====================================================================
-- Needed so ChangePinScreen can tell first-time setup (no PIN yet — nothing
-- to verify, just save the new one) apart from an actual PIN change (must
-- prove the old PIN or biometric first). Without this, an account with no
-- PIN (e.g. created via email/password, bypassing the phone-OTP onboarding
-- that normally sets one) can never set one at all: the "prove your
-- identity" gate can never be satisfied because there's no PIN to verify.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.has_user_pin()
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM user_pins WHERE user_id = auth.uid());
$$;

REVOKE EXECUTE ON FUNCTION public.has_user_pin() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.has_user_pin() TO authenticated, service_role;
