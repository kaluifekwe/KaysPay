-- Kay's Pay: lock email/phone post-signup, add optional NIN-based KYC
-- =====================================================================
-- Owner decision (2026-07-06, after testing the change_email/change_phone
-- flow live): email and phone are fixed at signup and never user-editable
-- again. The email_verification_codes system built for that (migration 040)
-- stays, narrowed to its one remaining purpose: verifying the signup email
-- itself. Also adds user_kyc — an optional, free, self-serve NIN check that
-- auto-syncs the verified name onto the profile.
-- =====================================================================

-- Test/diagnostic rows from the now-retired change_email/change_phone flow
-- would violate the narrower CHECK below — safe to drop, they're already
-- used or expired and carry no standing state.
DELETE FROM email_verification_codes WHERE purpose <> 'signup';

ALTER TABLE email_verification_codes DROP CONSTRAINT email_verification_codes_purpose_check;
ALTER TABLE email_verification_codes ADD CONSTRAINT email_verification_codes_purpose_check
  CHECK (purpose = 'signup');

-- ---------------------------------------------------------------------
-- user_kyc: one row per user, upserted only by kyc-verify-nin (service
-- role). Read-only to the owning user — same posture as transactions,
-- which already store full NIN records readably for the print-slip
-- feature, so this isn't a new class of exposure.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_kyc (
  user_id         UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  status          TEXT NOT NULL DEFAULT 'unverified' CHECK (status IN ('unverified', 'verified')),
  nin             TEXT,
  verified_record JSONB,
  verified_at     TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE user_kyc ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON user_kyc FROM anon, authenticated;

CREATE POLICY user_kyc_select_own ON user_kyc
  FOR SELECT
  USING (auth.uid() = user_id);

GRANT SELECT ON user_kyc TO authenticated;
GRANT ALL ON user_kyc TO service_role;

-- ---------------------------------------------------------------------
-- kyc_attempts: one row per verification attempt, used purely to rate-limit
-- kyc-verify-nin (5/24h/user) — this endpoint is free to the user but still
-- costs the owner a real provider call each time, so it needs a cap that
-- doesn't depend on the wallet-debit friction paid lookups have.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS kyc_attempts (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_kyc_attempts_user_created ON kyc_attempts (user_id, created_at DESC);

ALTER TABLE kyc_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON kyc_attempts FROM anon, authenticated;
GRANT ALL ON kyc_attempts TO service_role;
