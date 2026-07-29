-- Kay's Pay: cache of SMSPVA prices so the Foreign Number "pick a country"
-- screen loads instantly instead of hammering SMSPVA live on every tap.
-- =====================================================================
-- Previously foreign-number-countries queried SMSPVA live for all ~46
-- countries on every service tap (a multi-second "finding countries..."
-- delay). This single-row JSON cache holds {country: {serviceCode: usdPrice}}
-- for our curated services, refreshed every 15 min by `smspva-catalog-sync`.
-- The countries endpoint reads this row (one fast DB read) and only falls back
-- to a live fetch if the cache is empty/stale. Server-write only.
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.smspva_price_cache (
  id         int PRIMARY KEY,
  data       jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT smspva_price_cache_single CHECK (id = 1)
);

-- No RLS policies → only the service role (edge functions via adminClient) can
-- read/write it. Prices aren't secret, but there's no reason to expose the row
-- directly to clients — they get filtered results from foreign-number-countries.
ALTER TABLE public.smspva_price_cache ENABLE ROW LEVEL SECURITY;

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

SELECT cron.unschedule('smspva-catalog-sync')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'smspva-catalog-sync');

SELECT cron.schedule(
  'smspva-catalog-sync',
  '*/15 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://xswlrzhtxrzugoxdonjc.supabase.co/functions/v1/smspva-catalog-sync',
    headers := jsonb_build_object(
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inhzd2xyemh0eHJ6dWdveGRvbmpjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI1MTM3NjcsImV4cCI6MjA5ODA4OTc2N30.i5OKPZC3swGLpiadEdCHuqOhZJWNlyg4FAA-Ndu4uL0',
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);
