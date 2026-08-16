-- Kay's Pay: re-enable phone/email changes, this time with real step-up security
-- =====================================================================
-- Migration 041 locked email/phone forever after an earlier, weaker version
-- of this flow was tried and rolled back (2026-07-06). This rebuilds it with
-- the missing piece: every change now requires BOTH a PIN/biometric step-up
-- (consume_transaction_auth_token, migration 021 — the same gate that
-- protects every money-moving action) AND an OTP emailed to the account's
-- CURRENT email address (never SMS), proving the caller still controls the
-- account before either field can move. Name/address are unaffected — they
-- stay on the existing lower-friction PIN-only path.
--
-- Exception: adding a phone number when NONE is on file skips the OTP step
-- (still requires the PIN step-up) — there is no existing number to protect
-- against hijacking, so the extra round trip would be friction with no
-- security benefit. Once a phone exists, changing it goes through the full
-- OTP flow like email.
-- =====================================================================

ALTER TABLE email_verification_codes DROP CONSTRAINT email_verification_codes_purpose_check;
ALTER TABLE email_verification_codes ADD CONSTRAINT email_verification_codes_purpose_check
  CHECK (purpose IN ('signup', 'password_reset', 'change_email', 'change_phone'));

-- ---------------------------------------------------------------------
-- pending_profile_changes: holds the requested new value while its OTP is
-- outstanding. email_verification_codes only proves a code was right, it
-- doesn't carry an arbitrary payload — this is that payload. One row per
-- user (starting a new request overwrites any prior unconfirmed one).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pending_profile_changes (
  user_id      UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  field        TEXT NOT NULL CHECK (field IN ('email', 'phone')),
  new_value    TEXT NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL
);

ALTER TABLE pending_profile_changes ENABLE ROW LEVEL SECURITY;
-- Server-only, same posture as email_verification_codes/transaction_auth_tokens.
REVOKE ALL ON pending_profile_changes FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.set_pending_profile_change(
  p_user_id   UUID,
  p_field     TEXT,
  p_new_value TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO pending_profile_changes (user_id, field, new_value, requested_at, expires_at)
  VALUES (p_user_id, p_field, p_new_value, now(), now() + INTERVAL '15 minutes')
  ON CONFLICT (user_id) DO UPDATE
    SET field = p_field, new_value = p_new_value, requested_at = now(), expires_at = now() + INTERVAL '15 minutes';
END;
$$;

REVOKE EXECUTE ON FUNCTION public.set_pending_profile_change(UUID, TEXT, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.set_pending_profile_change(UUID, TEXT, TEXT) TO service_role;

-- Atomically claims the pending value on a successful OTP check: returns the
-- new value and deletes the row in one statement, so a code can never be
-- replayed to apply the same change twice.
CREATE OR REPLACE FUNCTION public.consume_pending_profile_change(
  p_user_id UUID,
  p_field   TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_value TEXT;
BEGIN
  DELETE FROM pending_profile_changes
   WHERE user_id = p_user_id AND field = p_field AND expires_at > now()
  RETURNING new_value INTO v_value;
  RETURN v_value;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.consume_pending_profile_change(UUID, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.consume_pending_profile_change(UUID, TEXT) TO service_role;
