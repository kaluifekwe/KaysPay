-- Transactional "finish your KYC" reminder -- same category as the welcome
-- email (about the customer's OWN incomplete signup, not a promotion), so
-- deliberately NOT run through marketing_campaigns/customer_marketing_preferences.
-- Consent for that system only gates promotional broadcasts; a reminder to
-- finish a process the customer already started doesn't need it, exactly
-- like the welcome email never has.
--
-- Sent once per account, 48h after signup, to anyone who verified their
-- email but never completed KYC -- same claim-and-release shape as
-- claim_due_welcome_emails (migration 052): SKIP LOCKED against concurrent
-- cron runs, released back to NULL if the actual send fails so it retries
-- next cycle. No default on the tracking column, same reasoning as
-- welcome_email_sent_at -- lets this reach every account already stuck
-- here today, not just future ones.

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS kyc_reminder_sent_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_users_kyc_reminder_pending
  ON public.users (created_at) WHERE kyc_reminder_sent_at IS NULL;

CREATE OR REPLACE FUNCTION public.claim_due_kyc_reminders(p_limit INT DEFAULT 50)
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
      LEFT JOIN public.user_kyc uk ON uk.user_id = u.id
     WHERE u.kyc_reminder_sent_at IS NULL
       AND u.created_at <= now() - INTERVAL '48 hours'
       AND au.email_confirmed_at IS NOT NULL
       AND au.email IS NOT NULL
       AND COALESCE(uk.status, 'unverified') <> 'verified'
     ORDER BY u.created_at
     LIMIT p_limit
     FOR UPDATE OF u SKIP LOCKED
  ),
  claimed AS (
    UPDATE public.users u
       SET kyc_reminder_sent_at = now()
      FROM due
     WHERE u.id = due.id
     RETURNING u.id, u.full_name
  )
  SELECT c.id, au.email::TEXT, c.full_name
    FROM claimed c
    JOIN auth.users au ON au.id = c.id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.claim_due_kyc_reminders(INT) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.claim_due_kyc_reminders(INT) TO service_role;

CREATE OR REPLACE FUNCTION public.unmark_kyc_reminder_sent(p_user_id UUID)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.users SET kyc_reminder_sent_at = NULL WHERE id = p_user_id;
$$;

REVOKE EXECUTE ON FUNCTION public.unmark_kyc_reminder_sent(UUID) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.unmark_kyc_reminder_sent(UUID) TO service_role;

-- No new function or cron job -- the project is at its 100-function plan
-- cap (hit twice already today). This claim/send pair runs from inside the
-- existing welcome-email function instead, reusing its cron trigger
-- (welcome-emails, */5 * * * *) rather than consuming a new slot.
