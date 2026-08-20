-- Kay's Pay: scheduled reconciliation of stuck crypto Sell orders
-- =================================================================
-- Mirrors migration 134 (crypto-buy-reconcile), for Sell instead of Buy.
-- Built after a real sale converted USDT -> NGN successfully on Quidax's
-- side but never credited the customer's wallet, because the settlement
-- webhook was rejected by a misconfigured QUIDAX_WEBHOOK_SECRET (since
-- fixed) and Sell had no reconcile sweep as a fallback — every other
-- crypto flow (Buy, as of today) already has one.
--
-- Every 5 minutes, tighter than Buy's 10-minute cadence: crypto-sell
-- confirms the swap synchronously before a row is ever created 'pending',
-- so a stuck Sell has already resolved on Quidax's side one way or another
-- by the time it's old enough to sweep (5 min floor, in the function
-- itself) — there's no customer-side wait (like a bank transfer) to avoid
-- interfering with.
-- =================================================================

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

SELECT cron.unschedule('crypto-sell-reconcile')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'crypto-sell-reconcile');

SELECT cron.schedule(
  'crypto-sell-reconcile',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://xswlrzhtxrzugoxdonjc.supabase.co/functions/v1/crypto-sell-reconcile',
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
