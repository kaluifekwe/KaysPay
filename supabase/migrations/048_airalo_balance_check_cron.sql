-- 048_airalo_balance_check_cron.sql
--
-- Schedules the airalo-balance-check edge function to run twice daily and
-- email the owner while the Airalo POSTPAID credit line is running low (Airalo
-- bills postpaid up to a $10,000 limit; at $0 available, new eSIM orders fail).
--
-- Same net.http_post + anon-JWT + x-cron-secret pattern as the reconcile
-- sweeps (migration 043) and fx-sync (migration 046).

DO $$
BEGIN
  PERFORM cron.unschedule('airalo-balance-check');
EXCEPTION
  WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'airalo-balance-check',
  '0 */12 * * *',
  $$
  SELECT net.http_post(
    url := 'https://xswlrzhtxrzugoxdonjc.supabase.co/functions/v1/airalo-balance-check',
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
