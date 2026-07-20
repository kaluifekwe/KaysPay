-- Kay's Pay: scheduled reconciliation of pending NIN validation orders
-- =====================================================================
-- Same pattern as migrations 016/019 (vtu-reconcile/esim-reconcile) — NIN
-- validation orders take 24-48h to resolve, so every 30 minutes is plenty
-- (no need for VTU's 5-minute cadence, which exists for near-instant orders).
-- =====================================================================

SELECT cron.schedule(
  'nin-reconcile-pending-validations',
  '*/30 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://xswlrzhtxrzugoxdonjc.supabase.co/functions/v1/nin-reconcile',
    headers := jsonb_build_object(
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inhzd2xyemh0eHJ6dWdveGRvbmpjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI1MTM3NjcsImV4cCI6MjA5ODA4OTc2N30.i5OKPZC3swGLpiadEdCHuqOhZJWNlyg4FAA-Ndu4uL0',
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);
