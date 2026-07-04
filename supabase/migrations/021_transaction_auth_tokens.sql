-- Kay's Pay: server-enforced transaction step-up authorization
-- =====================================================================
-- Closes a critical gap found in a security review: the PIN/biometric
-- screen (TransactionAuthProvider) was purely client-side UX. Nothing
-- stopped a valid JWT alone (stolen session, leaked token, modified
-- client) from calling vtu-purchase / foreign-number-purchase /
-- esim-purchase / paystack-transfer directly, skipping the PIN entirely.
--
-- Fix: verify_user_pin now mints a short-lived, limited-use token on
-- success. Every money-moving Edge Function must present that token and
-- have it validated server-side (consume_transaction_auth_token) BEFORE
-- touching the wallet. A JWT is no longer sufficient on its own.
--
-- max_uses/uses_count (not a plain used-once flag) exists specifically for
-- bulk send: one PIN entry authorizes sending airtime/data to many
-- contacts in one flow, without a purchase-per-recipient token (which
-- would need a PIN prompt per recipient — unusable UX). Regular single
-- purchases just pass max_uses = 1 (the default).
-- =====================================================================

CREATE TABLE IF NOT EXISTS transaction_auth_tokens (
  token       TEXT PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  max_uses    INT NOT NULL DEFAULT 1,
  uses_count  INT NOT NULL DEFAULT 0,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_transaction_auth_tokens_user ON transaction_auth_tokens (user_id);

ALTER TABLE transaction_auth_tokens ENABLE ROW LEVEL SECURITY;
-- No client policies: server-only, same as user_pins/processed_payments.
REVOKE ALL ON transaction_auth_tokens FROM anon, authenticated;

-- ---------------------------------------------------------------------
-- verify_user_pin: replaces the 006 version. Same bcrypt check + 5-attempt
-- /15-minute lockout, but now mints a token on success instead of just
-- returning `valid: true`.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.verify_user_pin(p_pin TEXT, p_max_uses INT DEFAULT 1)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_uid        UUID := auth.uid();
  v_row        user_pins%ROWTYPE;
  v_max        INT := 5;
  v_lock_mins  INT := 15;
  v_token      TEXT;
  v_ttl_secs   INT;
  v_expires_at TIMESTAMPTZ;
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

  -- Correct PIN: reset counters and mint a step-up token.
  IF v_row.pin_hash = crypt(p_pin, v_row.pin_hash) THEN
    UPDATE user_pins
       SET attempts = 0, locked_until = NULL, updated_at = now()
     WHERE user_id = v_uid;

    -- Opportunistic cleanup of this user's old tokens (keeps the table small).
    DELETE FROM transaction_auth_tokens WHERE user_id = v_uid AND expires_at < now();

    v_token := encode(gen_random_bytes(32), 'hex');
    -- Base 3-minute window, +3s per extra use for bulk-send batches.
    v_ttl_secs := 180 + (GREATEST(COALESCE(p_max_uses, 1), 1) - 1) * 3;
    v_expires_at := now() + make_interval(secs => v_ttl_secs);

    INSERT INTO transaction_auth_tokens (token, user_id, max_uses, expires_at)
    VALUES (v_token, v_uid, GREATEST(COALESCE(p_max_uses, 1), 1), v_expires_at);

    RETURN jsonb_build_object('valid', true, 'locked', false, 'token', v_token, 'expires_at', v_expires_at);
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

REVOKE EXECUTE ON FUNCTION public.verify_user_pin(TEXT, INT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.verify_user_pin(TEXT, INT) TO authenticated, service_role;

-- ---------------------------------------------------------------------
-- consume_transaction_auth_token: called by Edge Functions (service role
-- only) immediately before any wallet debit. Atomically claims one "use"
-- of the token; returns false if missing, expired, wrong user, or already
-- exhausted. The UPDATE's WHERE clause re-checks uses_count < max_uses
-- under the row lock the UPDATE itself takes, so concurrent calls for the
-- same token serialize correctly — no separate SELECT ... FOR UPDATE needed.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.consume_transaction_auth_token(p_user_id UUID, p_token TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_claimed BOOLEAN := FALSE;
BEGIN
  IF p_token IS NULL OR p_token = '' THEN
    RETURN FALSE;
  END IF;

  UPDATE transaction_auth_tokens
     SET uses_count = uses_count + 1
   WHERE token = p_token
     AND user_id = p_user_id
     AND expires_at > now()
     AND uses_count < max_uses;

  GET DIAGNOSTICS v_claimed = ROW_COUNT;
  RETURN v_claimed;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.consume_transaction_auth_token(UUID, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.consume_transaction_auth_token(UUID, TEXT) TO service_role;
