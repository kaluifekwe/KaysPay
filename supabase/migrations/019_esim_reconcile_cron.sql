-- Kay's Pay: scheduled reconciliation of stuck-pending eSIM Access orders
-- =====================================================================
-- Same pattern as migration 016 (vtu-reconcile) — eSIM Access orders can
-- take up to ~30s to allocate a profile, so esim-purchase responds
-- immediately with 'pending' rather than blocking the user, and this sweep
-- finishes the job in the background every 5 minutes.
-- =====================================================================

SELECT cron.schedule(
  'esim-reconcile-pending-orders',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://xswlrzhtxrzugoxdonjc.supabase.co/functions/v1/esim-reconcile',
    headers := jsonb_build_object(
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inhzd2xyemh0eHJ6dWdveGRvbmpjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI1MTM3NjcsImV4cCI6MjA5ODA4OTc2N30.i5OKPZC3swGLpiadEdCHuqOhZJWNlyg4FAA-Ndu4uL0',
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);
