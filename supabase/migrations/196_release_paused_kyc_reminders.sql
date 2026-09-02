-- Releases the 30 real accounts whose kyc_reminder_sent_at was deliberately
-- stamped to now() on 2026-09-02 18:57 UTC to pause the automatic cron while
-- the copy (removing NIN/BVN specifics, then em dashes) was reviewed and
-- approved. Confirmed via a temporary read-only diagnostic that all 30
-- stamps landed in that single minute -- no genuine send has gone out since,
-- so this is exactly the paused batch and nothing else.
--
-- Clearing it lets claim_due_kyc_reminders (migration 195) pick these
-- accounts up on its next run and send the real, approved email.
UPDATE public.users
SET kyc_reminder_sent_at = NULL
WHERE kyc_reminder_sent_at >= '2026-09-02 18:57:00+00'::timestamptz
  AND kyc_reminder_sent_at <  '2026-09-02 18:58:00+00'::timestamptz;
