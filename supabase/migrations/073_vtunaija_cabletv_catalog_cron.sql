-- Live VTUnaija cable TV catalogue sync, every 5 min — mirrors
-- 069_vtunaija_data_catalog_cron.sql's cron block.
SELECT cron.unschedule('vtunaija-cabletv-catalog-sync')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'vtunaija-cabletv-catalog-sync');

SELECT cron.schedule(
  'vtunaija-cabletv-catalog-sync',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://xswlrzhtxrzugoxdonjc.supabase.co/functions/v1/vtunaija-cabletv-catalog',
    headers := jsonb_build_object(
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inhzd2xyemh0eHJ6dWdveGRvbmpjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI1MTM3NjcsImV4cCI6MjA5ODA4OTc2N30.i5OKPZC3swGLpiadEdCHuqOhZJWNlyg4FAA-Ndu4uL0',
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret')
    ),
    body := '{"refresh":true}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);
