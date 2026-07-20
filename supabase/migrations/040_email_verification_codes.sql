-- Kay's Pay: Resend-based email verification codes
-- =====================================================================
-- Replaces Supabase Auth's link-based "Confirm email" with a self-built
-- 6-digit code, emailed via Resend, entered right after signup. The same
-- table/functions also gate email-address and phone-number changes from
-- the Edit Profile screen.
--
-- Only ever called from Edge Functions (send-email-otp / verify-email-otp)
-- via the service-role client, never directly from the app — so, like
-- consume_transaction_auth_token (migration 021), these take an explicit
-- p_user_id instead of relying on auth.uid() (which is NULL under a
-- service-role connection with no user JWT attached).
-- =====================================================================

CREATE TABLE IF NOT EXISTS email_verification_codes (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  purpose      TEXT NOT NULL CHECK (purpose IN ('signup', 'change_email', 'change_phone')),
  -- The email/phone this code is proving control of/intent for. For
  -- 'signup' and 'change_email' this is the email address the code was
  -- actually sent to. For 'change_phone' this is the NEW phone number
  -- being requested — the code itself is emailed to the account's current
  -- address instead (a phone can't receive email), so `target` here is
  -- what verify_email_verification_code must be told to apply on success,
  -- not where the code was delivered.
  target       TEXT NOT NULL,
  code_hash    TEXT NOT NULL,
  attempts     INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 5,
  expires_at   TIMESTAMPTZ NOT NULL,
  used_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_verification_codes_lookup
  ON email_verification_codes (user_id, purpose, created_at DESC);

ALTER TABLE email_verification_codes ENABLE ROW LEVEL SECURITY;
-- Server-only, same posture as user_pins/transaction_auth_tokens.
REVOKE ALL ON email_verification_codes FROM anon, authenticated;

-- ---------------------------------------------------------------------
-- create_email_verification_code: generates a fresh row for a plaintext
-- code the caller (send-email-otp) already generated and will email.
-- Enforces a 60s cooldown between requests and a 10/24h cap per
-- user+purpose, so this can't be used to spam Resend or run up cost.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_email_verification_code(
  p_user_id UUID,
  p_purpose TEXT,
  p_target  TEXT,
  p_code    TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_last_created TIMESTAMPTZ;
  v_recent_count INT;
BEGIN
  SELECT created_at INTO v_last_created
    FROM email_verification_codes
   WHERE user_id = p_user_id AND purpose = p_purpose
   ORDER BY created_at DESC
   LIMIT 1;

  IF v_last_created IS NOT NULL AND v_last_created > now() - INTERVAL '60 seconds' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'RATE_LIMITED');
  END IF;

  SELECT count(*) INTO v_recent_count
    FROM email_verification_codes
   WHERE user_id = p_user_id AND purpose = p_purpose
     AND created_at > now() - INTERVAL '24 hours';

  IF v_recent_count >= 10 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'DAILY_LIMIT_REACHED');
  END IF;

  INSERT INTO email_verification_codes (user_id, purpose, target, code_hash, expires_at)
  VALUES (p_user_id, p_purpose, p_target, crypt(p_code, gen_salt('bf', 10)), now() + INTERVAL '10 minutes');

  RETURN jsonb_build_object('ok', true);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.create_email_verification_code(UUID, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.create_email_verification_code(UUID, TEXT, TEXT, TEXT) TO service_role;

-- ---------------------------------------------------------------------
-- verify_email_verification_code: checks the latest unused code for
-- user+purpose+target. Same 5-attempt lockout shape as verify_user_pin,
-- but scoped to the single code row (a fresh code request always starts
-- attempts back at 0, unlike the PIN's standing lockout).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.verify_email_verification_code(
  p_user_id UUID,
  p_purpose TEXT,
  p_target  TEXT,
  p_code    TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_row email_verification_codes%ROWTYPE;
BEGIN
  SELECT * INTO v_row
    FROM email_verification_codes
   WHERE user_id = p_user_id AND purpose = p_purpose AND target = p_target AND used_at IS NULL
   ORDER BY created_at DESC
   LIMIT 1
   FOR UPDATE;

  IF v_row.id IS NULL THEN
    RETURN jsonb_build_object('valid', false, 'locked', false, 'error', 'NOT_FOUND');
  END IF;

  IF v_row.expires_at < now() THEN
    RETURN jsonb_build_object('valid', false, 'locked', false, 'error', 'EXPIRED');
  END IF;

  IF v_row.attempts >= v_row.max_attempts THEN
    RETURN jsonb_build_object('valid', false, 'locked', true, 'attempts_remaining', 0);
  END IF;

  IF v_row.code_hash = crypt(p_code, v_row.code_hash) THEN
    UPDATE email_verification_codes SET used_at = now() WHERE id = v_row.id;
    RETURN jsonb_build_object('valid', true, 'locked', false);
  END IF;

  UPDATE email_verification_codes SET attempts = attempts + 1 WHERE id = v_row.id;

  RETURN jsonb_build_object(
    'valid', false,
    'locked', (v_row.attempts + 1) >= v_row.max_attempts,
    'attempts_remaining', GREATEST(v_row.max_attempts - (v_row.attempts + 1), 0)
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.verify_email_verification_code(UUID, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.verify_email_verification_code(UUID, TEXT, TEXT, TEXT) TO service_role;

-- ---------------------------------------------------------------------
-- One-time backfill: mark everyone already confirmed under the old
-- link-based flow as verified, so the new mandatory gate (added in the
-- app once this ships) doesn't lock out existing users.
-- ---------------------------------------------------------------------
UPDATE auth.users
   SET raw_user_meta_data = COALESCE(raw_user_meta_data, '{}'::jsonb) || '{"email_verified": true}'::jsonb
 WHERE email_confirmed_at IS NOT NULL;
