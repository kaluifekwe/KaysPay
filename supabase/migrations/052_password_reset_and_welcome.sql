-- 052_password_reset_and_welcome.sql
-- =====================================================================
-- Two features:
--   1. Forgot-password reset codes — reuses the existing bcrypt-hashed,
--      rate-limited, 5-attempt-lockout email_verification_codes machinery
--      (migration 040) under a new 'password_reset' purpose. The reset
--      Edge Functions are unauthenticated (the user has no session), so
--      they resolve email -> user_id server-side via get_user_id_by_email.
--   2. Founder welcome email, sent ~10 minutes after signup by the
--      welcome-email cron. Tracked with users.welcome_email_sent_at so it
--      fires exactly once per account.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. Public storage bucket for branding assets (the email logo). Public
--    buckets are served at /storage/v1/object/public/<bucket>/* with no
--    auth, which is exactly what an email <img src> needs. The logo PNG
--    itself is uploaded at deploy time (kayspay-logo.png).
-- ---------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public)
VALUES ('branding', 'branding', true)
ON CONFLICT (id) DO UPDATE SET public = true;

-- ---------------------------------------------------------------------
-- 1a. Re-widen the code purpose to allow password_reset (041 had locked
--     it to 'signup' only).
-- ---------------------------------------------------------------------
ALTER TABLE email_verification_codes DROP CONSTRAINT IF EXISTS email_verification_codes_purpose_check;
ALTER TABLE email_verification_codes ADD CONSTRAINT email_verification_codes_purpose_check
  CHECK (purpose IN ('signup', 'password_reset'));

-- ---------------------------------------------------------------------
-- 1b. Resolve an email to its auth user id, case-insensitively. Used by
--     the (unauthenticated) reset Edge Functions. SECURITY DEFINER so it
--     can read auth.users; service-role only. Returns NULL when no match
--     — callers must NOT reveal that to the client (anti-enumeration).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_user_id_by_email(p_email TEXT)
RETURNS UUID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id FROM auth.users WHERE lower(email) = lower(p_email) LIMIT 1;
$$;

REVOKE EXECUTE ON FUNCTION public.get_user_id_by_email(TEXT) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.get_user_id_by_email(TEXT) TO service_role;

-- ---------------------------------------------------------------------
-- 2a. Welcome-email tracking column. No default on purpose: new signups
--     must land as NULL so the cron picks them up. Existing users are
--     backfilled to now() so deploying this does NOT blast the whole
--     user base with a welcome email.
-- ---------------------------------------------------------------------
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS welcome_email_sent_at TIMESTAMPTZ;

UPDATE public.users SET welcome_email_sent_at = now() WHERE welcome_email_sent_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_users_welcome_pending
  ON public.users (created_at) WHERE welcome_email_sent_at IS NULL;

-- ---------------------------------------------------------------------
-- 2b. Atomically claim users due for a welcome email and return their
--     address + name. "Due" = not yet welcomed, signed up >= 10 min ago,
--     and email verified (so we never email an unconfirmed/typo address).
--     Claims by stamping welcome_email_sent_at up-front under a row lock
--     (SKIP LOCKED) so two overlapping cron runs can't double-send; the
--     welcome-email function calls unmark_welcome_sent to release a row
--     if the actual send fails, so it retries next cycle.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_due_welcome_emails(p_limit INT DEFAULT 50)
RETURNS TABLE(user_id UUID, email TEXT, full_name TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT u.id
      FROM public.users u
      JOIN auth.users au ON au.id = u.id
     WHERE u.welcome_email_sent_at IS NULL
       AND u.created_at <= now() - INTERVAL '10 minutes'
       AND COALESCE(au.raw_user_meta_data->>'email_verified', '') = 'true'
       AND au.email IS NOT NULL
     ORDER BY u.created_at
     LIMIT p_limit
     FOR UPDATE OF u SKIP LOCKED
  ),
  claimed AS (
    UPDATE public.users u
       SET welcome_email_sent_at = now()
      FROM due
     WHERE u.id = due.id
     RETURNING u.id, u.full_name
  )
  SELECT c.id, au.email::TEXT, c.full_name
    FROM claimed c
    JOIN auth.users au ON au.id = c.id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.claim_due_welcome_emails(INT) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.claim_due_welcome_emails(INT) TO service_role;

-- Release a claimed row when the send fails, so it's retried next run.
CREATE OR REPLACE FUNCTION public.unmark_welcome_sent(p_user_id UUID)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.users SET welcome_email_sent_at = NULL WHERE id = p_user_id;
$$;

REVOKE EXECUTE ON FUNCTION public.unmark_welcome_sent(UUID) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.unmark_welcome_sent(UUID) TO service_role;

-- ---------------------------------------------------------------------
-- 2c. Cron: deliver welcome emails every 5 minutes. Same net.http_post +
--     anon-JWT + x-cron-secret pattern as the other crons (migration 051).
-- ---------------------------------------------------------------------
DO $$
BEGIN
  PERFORM cron.unschedule('welcome-emails');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'welcome-emails',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://xswlrzhtxrzugoxdonjc.supabase.co/functions/v1/welcome-email',
    headers := jsonb_build_object(
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inhzd2xyemh0eHJ6dWdveGRvbmpjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI1MTM3NjcsImV4cCI6MjA5ODA4OTc2N30.i5OKPZC3swGLpiadEdCHuqOhZJWNlyg4FAA-Ndu4uL0',
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $$
);
