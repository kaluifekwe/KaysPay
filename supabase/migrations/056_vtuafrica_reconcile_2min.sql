-- Kay's Pay: speed up VTUAfrica reconciliation from every 5 min to every 30s
-- =====================================================================
-- VTUAfrica returns an async "Processing" status for some orders (e.g. Glo
-- airtime, confirmed live 2026-07-30) — those are held 'pending' by
-- vtu-purchase and only confirmed by this sweep. At every-5-min the user saw a
-- long "Processing" state; every-30s settles it as soon as VTUAfrica finishes.
-- Same job name (upserts the schedule from migration 034), same URL/headers,
-- just a tighter cadence. withJobLock in the function still prevents
-- overlapping runs, so a slow verify can't stack up parallel sweeps.
-- NOTE: the hard floor is VTUAfrica's own processing time — this detects
-- completion sooner, it can't make the provider deliver faster.
-- =====================================================================

SELECT cron.schedule(
  'vtuafrica-reconcile-pending-orders',
  '30 seconds',
  $$
  SELECT net.http_post(
    url := 'https://xswlrzhtxrzugoxdonjc.supabase.co/functions/v1/vtuafrica-reconcile',
    headers := jsonb_build_object(
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inhzd2xyemh0eHJ6dWdveGRvbmpjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI1MTM3NjcsImV4cCI6MjA5ODA4OTc2N30.i5OKPZC3swGLpiadEdCHuqOhZJWNlyg4FAA-Ndu4uL0',
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);
