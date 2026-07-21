-- 046_fx_rates.sql
--
-- Live USD->NGN rate for eSIM pricing. Replaces the hardcoded USD_TO_NGN_RATE
-- snapshot in _shared/esim-catalog.ts with a value refreshed daily by the
-- `fx-sync` edge function from a public interbank feed (open.er-api.com).
-- esim-browse / esim-purchase read this row via getUsdNgnRate() and apply the
-- FX buffer + margin on top; the code falls back to a constant if the row is
-- ever missing, so this table can never break checkout.

CREATE TABLE IF NOT EXISTS public.fx_rates (
  pair       TEXT PRIMARY KEY,
  rate       NUMERIC NOT NULL CHECK (rate > 0),
  source     TEXT,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Server-only: the fx-sync function writes via the service role (which
-- bypasses RLS). Clients never read or write this directly — pricing reaches
-- them pre-computed in the esim-browse response.
ALTER TABLE public.fx_rates ENABLE ROW LEVEL SECURITY;
REVOKE INSERT, UPDATE, DELETE ON public.fx_rates FROM anon, authenticated;

-- Seed a sane starting value so pricing works before the first cron run.
INSERT INTO public.fx_rates (pair, rate, source)
VALUES ('USD_NGN', 1450, 'seed')
ON CONFLICT (pair) DO NOTHING;

-- Daily refresh at 00:30 UTC — the feed publishes a new rate ~00:14 UTC.
-- Same net.http_post + anon-JWT + x-cron-secret pattern as the reconcile
-- sweeps (migration 043). The anon key is public (ships in the app), and the
-- real auth is the x-cron-secret pulled from Vault.
DO $$
BEGIN
  PERFORM cron.unschedule('fx-sync-daily');
EXCEPTION
  WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'fx-sync-daily',
  '30 0 * * *',
  $$
  SELECT net.http_post(
    url := 'https://xswlrzhtxrzugoxdonjc.supabase.co/functions/v1/fx-sync',
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
