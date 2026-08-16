-- Secure forgotten transaction-PIN recovery. The existing set_user_pin flow
-- still requires the old PIN; this separate server-only path requires a
-- short-lived, one-use email OTP and resets the PIN atomically.
ALTER TABLE public.email_verification_codes
  DROP CONSTRAINT IF EXISTS email_verification_codes_purpose_check;
ALTER TABLE public.email_verification_codes
  ADD CONSTRAINT email_verification_codes_purpose_check
  CHECK (purpose IN ('signup', 'password_reset', 'change_email', 'change_phone', 'pin_reset'));

CREATE TABLE public.security_audit_log (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  event TEXT NOT NULL CHECK (event IN ('transaction_pin_reset')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (length(metadata::TEXT) <= 512),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_security_audit_user ON public.security_audit_log(user_id, created_at DESC);
ALTER TABLE public.security_audit_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.security_audit_log FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.security_audit_log TO service_role;

CREATE OR REPLACE FUNCTION public.reset_transaction_pin_with_email_code(
  p_user_id UUID,
  p_email TEXT,
  p_code TEXT,
  p_new_pin TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_code public.email_verification_codes%ROWTYPE;
BEGIN
  IF p_new_pin !~ '^\d{4}$' THEN
    RETURN jsonb_build_object('success', false, 'error', 'INVALID_PIN');
  END IF;

  SELECT * INTO v_code
  FROM public.email_verification_codes
  WHERE user_id = p_user_id
    AND purpose = 'pin_reset'
    AND target = lower(trim(p_email))
    AND used_at IS NULL
  ORDER BY created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF v_code.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'NOT_FOUND');
  END IF;
  IF v_code.expires_at < now() THEN
    RETURN jsonb_build_object('success', false, 'error', 'EXPIRED');
  END IF;
  IF v_code.attempts >= v_code.max_attempts THEN
    RETURN jsonb_build_object('success', false, 'error', 'LOCKED');
  END IF;
  IF v_code.code_hash <> crypt(p_code, v_code.code_hash) THEN
    UPDATE public.email_verification_codes SET attempts = attempts + 1 WHERE id = v_code.id;
    RETURN jsonb_build_object(
      'success', false,
      'error', CASE WHEN v_code.attempts + 1 >= v_code.max_attempts THEN 'LOCKED' ELSE 'INCORRECT' END,
      'attempts_remaining', greatest(v_code.max_attempts - (v_code.attempts + 1), 0)
    );
  END IF;

  UPDATE public.email_verification_codes SET used_at = now() WHERE id = v_code.id;
  INSERT INTO public.user_pins(user_id, pin_hash, attempts, locked_until, updated_at)
  VALUES (p_user_id, crypt(p_new_pin, gen_salt('bf', 10)), 0, NULL, now())
  ON CONFLICT (user_id) DO UPDATE SET
    pin_hash = EXCLUDED.pin_hash,
    attempts = 0,
    locked_until = NULL,
    updated_at = now();

  -- Every proof minted using the old PIN becomes invalid immediately.
  DELETE FROM public.transaction_auth_tokens WHERE user_id = p_user_id;

  INSERT INTO public.security_audit_log(user_id, event, metadata)
  VALUES (p_user_id, 'transaction_pin_reset', jsonb_build_object('method', 'verified_email_otp'));

  INSERT INTO public.notifications(user_id, title, body, type, data)
  VALUES (
    p_user_id,
    'Transaction PIN changed',
    'Your transaction PIN was reset successfully. If this was not you, contact support immediately.',
    'system',
    jsonb_build_object('event', 'transaction_pin_reset')
  );

  RETURN jsonb_build_object('success', true);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.reset_transaction_pin_with_email_code(UUID,TEXT,TEXT,TEXT)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reset_transaction_pin_with_email_code(UUID,TEXT,TEXT,TEXT)
TO service_role;
