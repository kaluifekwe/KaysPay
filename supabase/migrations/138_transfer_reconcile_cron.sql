-- Kay's Pay: scheduled reconciliation of stuck Wallet Transfer payouts
-- =================================================================
-- Mirrors migrations 134/136 (crypto-buy-reconcile, crypto-sell-reconcile),
-- for Transfer instead. Requeries whichever provider actually handled the
-- send (Flutterwave primary, Paystack automatic fallback) and settles
-- anything stuck without a webhook ever arriving.
--
-- 10-minute floor (matches Buy's cadence, not Sell's 5-minute one): a bank
-- payout genuinely takes the provider real processing time, unlike Sell's
-- synchronous swap confirm.
-- =================================================================

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

SELECT cron.unschedule('transfer-reconcile')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'transfer-reconcile');

SELECT cron.schedule(
  'transfer-reconcile',
  '*/10 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://xswlrzhtxrzugoxdonjc.supabase.co/functions/v1/transfer-reconcile',
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
