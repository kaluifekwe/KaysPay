-- Kay's Pay: scheduled reconciliation of stuck-pending VTU.ng orders
-- =====================================================================
-- VTU.ng's webhook only fires for admin-forced completions and refunds —
-- NOT for the normal case of an order completing automatically on its own
-- (confirmed by testing: a real order completed on VTU.ng's side but our
-- webhook never received anything). Any order vtu-purchase's short
-- synchronous requery loop couldn't resolve is therefore left 'pending'
-- with no way to ever finalize it — unless something re-checks periodically.
--
-- This schedules the `vtu-reconcile` Edge Function every 5 minutes via
-- pg_cron + pg_net. The Authorization header uses the ANON key, which is
-- meant to be public (it already ships inside the app bundle) — safe to
-- embed directly here, unlike a service-role key or provider secret.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

SELECT cron.schedule(
  'vtu-reconcile-pending-orders',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://xswlrzhtxrzugoxdonjc.supabase.co/functions/v1/vtu-reconcile',
    headers := jsonb_build_object(
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inhzd2xyemh0eHJ6dWdveGRvbmpjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI1MTM3NjcsImV4cCI6MjA5ODA4OTc2N30.i5OKPZC3swGLpiadEdCHuqOhZJWNlyg4FAA-Ndu4uL0',
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);
