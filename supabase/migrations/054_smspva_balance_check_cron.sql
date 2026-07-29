-- Kay's Pay: low-balance alert for the SMSPVA prepaid account
-- =====================================================================
-- SMSPVA powers the Foreign Number feature (real-SIM OTP numbers). It's
-- pay-as-you-go — when the balance hits $0, purchases fail and customers get
-- auto-refunded. This schedules `smspva-balance-check` every 12 hours to email
-- the owner while the balance is below threshold, so there's time to top up.
-- Auth mirrors the other reconcile/alert crons: anon Bearer + x-cron-secret
-- from Vault (which the function verifies against CRON_SECRET).
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

SELECT cron.unschedule('smspva-balance-check')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'smspva-balance-check');

SELECT cron.schedule(
  'smspva-balance-check',
  '0 */12 * * *',
  $$
  SELECT net.http_post(
    url := 'https://xswlrzhtxrzugoxdonjc.supabase.co/functions/v1/smspva-balance-check',
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
