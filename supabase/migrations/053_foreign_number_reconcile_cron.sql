-- Kay's Pay: scheduled reconciliation of expired Foreign Number purchases
-- =====================================================================
-- A Foreign Number purchase completes immediately on rental (the number is
-- the paid-for good). If no SMS code ever arrives, the number expires (~20
-- min) and GrizzlySMS marks it STATUS_CANCEL. foreign-number-status already
-- auto-refunds that while the user is on-screen polling — but if the user
-- CLOSED the app first, nothing re-checks, so the charge would sit forever.
--
-- This schedules `foreign-number-reconcile` every 10 minutes to refund those
-- abandoned, expired-with-no-code purchases. Auth mirrors the other live
-- reconcile crons exactly: anon Bearer (public, ships in the app) to pass the
-- function gate + an x-cron-secret header read from Vault, which the function
-- verifies against its CRON_SECRET. Idempotent refund RPC → safe to overlap
-- with the in-screen poll / manual cancel.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- Idempotent (re)schedule.
SELECT cron.unschedule('foreign-number-reconcile')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'foreign-number-reconcile');

SELECT cron.schedule(
  'foreign-number-reconcile',
  '*/10 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://xswlrzhtxrzugoxdonjc.supabase.co/functions/v1/foreign-number-reconcile',
    headers := jsonb_build_object(
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inhzd2xyemh0eHJ6dWdveGRvbmpjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI1MTM3NjcsImV4cCI6MjA5ODA4OTc2N30.i5OKPZC3swGLpiadEdCHuqOhZJWNlyg4FAA-Ndu4uL0',
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);
