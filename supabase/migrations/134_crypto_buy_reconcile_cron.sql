-- Kay's Pay: scheduled reconciliation of stuck crypto Buy orders
-- ================================================================
-- Every other money-in-flight flow in this app (VTU, eSIM, NIN, foreign
-- number, funding) has a reconcile sweep for the case a provider's webhook
-- never arrives. Buy (Quidax Ramp) did not. crypto-buy-reconcile requeries
-- Quidax directly for any 'crypto_buy' still 'pending' 30+ minutes after
-- creation (short enough to catch stragglers, long enough not to chase
-- orders still legitimately waiting on the customer's bank transfer).
--
-- Runs every 10 minutes — same cadence as foreign-number-reconcile, not the
-- 2-5 minute cadence funding-reconcile uses, since Buy orders are far lower
-- volume and a stuck purchase sitting an extra few minutes is not the same
-- urgency as an unrecognized incoming deposit.
-- ================================================================

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

SELECT cron.unschedule('crypto-buy-reconcile')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'crypto-buy-reconcile');

SELECT cron.schedule(
  'crypto-buy-reconcile',
  '*/10 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://xswlrzhtxrzugoxdonjc.supabase.co/functions/v1/crypto-buy-reconcile',
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
