-- Migration 191's backfill inserted 33 profile rows without setting
-- welcome_email_sent_at, which has no default (migration 052) specifically
-- so the welcome-email cron only ever emails genuinely new signups. Those
-- 33 rows sat with welcome_email_sent_at=NULL and a real (old) created_at
-- once 192 corrected it -- both conditions the cron's claim_due_welcome_emails
-- treats as "a real signup, over 10 minutes old, never welcomed" -- so it
-- correctly-by-its-own-logic started sending months-late "welcome" emails
-- to real people's (and test) inboxes today. Confirmed live: 32 of 33 had
-- already been claimed by the time this was caught.
--
-- Only touches rows with an old created_at (anything over an hour old
-- cannot be a genuine new signup this cron should still catch), so this
-- can never suppress a real new user's actual welcome email.
UPDATE public.users
SET welcome_email_sent_at = now()
WHERE welcome_email_sent_at IS NULL
  AND created_at < now() - interval '1 hour';
