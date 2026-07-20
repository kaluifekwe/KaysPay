-- Kay's Pay: scheduled reconciliation of pending VTUAfrica orders
-- =====================================================================
-- Same pattern as migration 016 (vtu-reconcile). VTUAfrica orders can be
-- async (betting "Processing" confirmed live 2026-07-04) — vtu-purchase now
-- holds those 'pending' instead of wrongly refunding, and this sweep settles
-- them every 5 minutes by requerying VTUAfrica's transaction endpoint.
-- =====================================================================

SELECT cron.schedule(
  'vtuafrica-reconcile-pending-orders',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://xswlrzhtxrzugoxdonjc.supabase.co/functions/v1/vtuafrica-reconcile',
    headers := jsonb_build_object(
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inhzd2xyemh0eHJ6dWdveGRvbmpjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI1MTM3NjcsImV4cCI6MjA5ODA4OTc2N30.i5OKPZC3swGLpiadEdCHuqOhZJWNlyg4FAA-Ndu4uL0',
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);
