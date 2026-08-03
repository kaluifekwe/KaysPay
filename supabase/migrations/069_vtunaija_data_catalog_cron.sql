-- Live VTUnaija data catalogue sync, every 5 min — mirrors
-- 065_vtung_live_data_catalog.sql's cron block. Does NOT unschedule
-- vtung-data-catalog-sync: that stays running until Phase 1b (this migration)
-- is confirmed stable in production, per the VTUnaija migration rollback plan.

SELECT cron.unschedule('vtunaija-data-catalog-sync')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'vtunaija-data-catalog-sync');

SELECT cron.schedule(
  'vtunaija-data-catalog-sync',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://xswlrzhtxrzugoxdonjc.supabase.co/functions/v1/vtunaija-data-catalog',
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
