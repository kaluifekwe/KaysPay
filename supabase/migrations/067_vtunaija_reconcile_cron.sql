-- Kay's Pay: scheduled reconciliation of pending VTUnaija airtime orders
-- =====================================================================
-- VTUnaija documents no async "processing" state for airtime (unlike VTU.ng
-- and VTUAfrica), so this sweep should rarely find anything beyond a genuine
-- network-blip-induced ambiguity from vtu-purchase. A conservative 2-minute
-- cadence is deliberate here (contrast with VTUAfrica's 30-second cadence,
-- tuned for a documented multi-second "Processing" window VTUnaija doesn't
-- have) — tighten only if real "stuck pending" incidents justify it.
--
-- Does NOT unschedule vtu-reconcile-pending-orders: data purchases still
-- route to VTU.ng until VTUnaija's account_Id field is confirmed (Phase 1b
-- of the VTUnaija migration), so that sweep is still needed.
-- =====================================================================

SELECT cron.schedule(
  'vtunaija-reconcile-pending-orders',
  '*/2 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://xswlrzhtxrzugoxdonjc.supabase.co/functions/v1/vtunaija-reconcile',
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
