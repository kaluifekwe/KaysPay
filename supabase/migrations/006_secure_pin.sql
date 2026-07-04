-- Kay's Pay: Secure transaction PIN (hashed + rate-limited)
-- =====================================================================
-- Replaces the plaintext PIN (previously stored in auth user metadata and
-- on-device) with a bcrypt hash held in a SERVER-ONLY table. The hash is
-- never readable by the client, so a 4-digit PIN cannot be brute-forced
-- offline; online attempts are rate-limited with a lockout.
-- =====================================================================

-- bcrypt (crypt / gen_salt) lives in pgcrypto.
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- Server-only PIN store. No RLS policies + revoked grants => the client can
-- never SELECT the hash. Only the SECURITY DEFINER functions below touch it.
CREATE TABLE IF NOT EXISTS user_pins (
  user_id      UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  pin_hash     TEXT NOT NULL,
  attempts     INT  NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE user_pins ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON user_pins FROM anon, authenticated;

-- ---------------------------------------------------------------------
-- set_user_pin: hash and store the caller's PIN. Uses auth.uid() so a
-- user can only ever set their own PIN.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_user_pin(p_pin TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_uid UUID := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED';
  END IF;
  IF p_pin !~ '^\d{4}$' THEN
    RAISE EXCEPTION 'INVALID_PIN';
  END IF;

  INSERT INTO user_pins (user_id, pin_hash, attempts, locked_until, updated_at)
  VALUES (v_uid, crypt(p_pin, gen_salt('bf', 10)), 0, NULL, now())
  ON CONFLICT (user_id) DO UPDATE
    SET pin_hash = EXCLUDED.pin_hash,
        attempts = 0,
        locked_until = NULL,
        updated_at = now();
END;
$$;

-- ---------------------------------------------------------------------
-- verify_user_pin: check the caller's PIN with lockout. Returns
-- { valid, locked, locked_until, attempts_remaining }.
-- After 5 wrong attempts the PIN locks for 15 minutes.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.verify_user_pin(p_pin TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_uid       UUID := auth.uid();
  v_row       user_pins%ROWTYPE;
  v_max       INT := 5;
  v_lock_mins INT := 15;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED';
  END IF;

  SELECT * INTO v_row FROM user_pins WHERE user_id = v_uid FOR UPDATE;

  IF v_row.user_id IS NULL THEN
    RETURN jsonb_build_object('valid', false, 'locked', false, 'error', 'NO_PIN_SET');
  END IF;

  -- Currently locked out?
  IF v_row.locked_until IS NOT NULL AND v_row.locked_until > now() THEN
    RETURN jsonb_build_object('valid', false, 'locked', true,
                              'locked_until', v_row.locked_until, 'attempts_remaining', 0);
  END IF;

  -- Correct PIN: reset counters.
  IF v_row.pin_hash = crypt(p_pin, v_row.pin_hash) THEN
    UPDATE user_pins
       SET attempts = 0, locked_until = NULL, updated_at = now()
     WHERE user_id = v_uid;
    RETURN jsonb_build_object('valid', true, 'locked', false);
  END IF;

  -- Wrong PIN: increment and possibly lock.
  IF v_row.attempts + 1 >= v_max THEN
    UPDATE user_pins
       SET attempts = 0, locked_until = now() + make_interval(mins => v_lock_mins), updated_at = now()
     WHERE user_id = v_uid;
    RETURN jsonb_build_object('valid', false, 'locked', true,
                              'locked_until', now() + make_interval(mins => v_lock_mins),
                              'attempts_remaining', 0);
  END IF;

  UPDATE user_pins
     SET attempts = v_row.attempts + 1, updated_at = now()
   WHERE user_id = v_uid;
  RETURN jsonb_build_object('valid', false, 'locked', false,
                            'attempts_remaining', v_max - (v_row.attempts + 1));
END;
$$;

-- These are safe for clients to call directly: they act only on the caller's
-- own row (via auth.uid()) and the lockout limits brute force.
REVOKE EXECUTE ON FUNCTION public.set_user_pin(TEXT)    FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.verify_user_pin(TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.set_user_pin(TEXT)    TO authenticated, service_role;
GRANT  EXECUTE ON FUNCTION public.verify_user_pin(TEXT) TO authenticated, service_role;

-- The old plaintext column on the client-readable users row is no longer used.
-- Drop its legacy NOT NULL (from migration 001) and blank any plaintext PIN.
ALTER TABLE users ALTER COLUMN pin_hash DROP NOT NULL;
UPDATE users SET pin_hash = NULL WHERE pin_hash IS NOT NULL;
