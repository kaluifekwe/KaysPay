-- 049_esim_catalog.sql
--
-- Backing store for the FULL, self-updating eSIM destination list. Instead of
-- a hardcoded ~110-country list in the app, the `esim-catalog` edge function
-- fetches Airalo's complete catalogue (all local countries + all regional /
-- worldwide packages), extracts the destination list, and caches it here. The
-- app reads this list, so it always covers 100% of Airalo's countries + the
-- regional/global plans, and stays current automatically.
--
-- Single-row table (id = 1). Server-only writes (the edge function uses the
-- service role, which bypasses RLS); clients never touch it directly — they
-- get the list through the esim-catalog function.

CREATE TABLE IF NOT EXISTS public.esim_catalog (
  id         INT PRIMARY KEY DEFAULT 1,
  countries  JSONB NOT NULL DEFAULT '[]'::jsonb,
  regions    JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT esim_catalog_singleton CHECK (id = 1)
);

ALTER TABLE public.esim_catalog ENABLE ROW LEVEL SECURITY;
REVOKE INSERT, UPDATE, DELETE ON public.esim_catalog FROM anon, authenticated;

INSERT INTO public.esim_catalog (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Daily refresh at 01:00 UTC: POST {"refresh":true} to esim-catalog, which
-- re-pulls Airalo's catalogue and updates the row. Same net.http_post +
-- anon-JWT + x-cron-secret pattern as the other crons (migration 043/046/048).
DO $$
BEGIN
  PERFORM cron.unschedule('esim-catalog-sync');
EXCEPTION
  WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'esim-catalog-sync',
  '0 1 * * *',
  $$
  SELECT net.http_post(
    url := 'https://xswlrzhtxrzugoxdonjc.supabase.co/functions/v1/esim-catalog',
    headers := jsonb_build_object(
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inhzd2xyemh0eHJ6dWdveGRvbmpjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI1MTM3NjcsImV4cCI6MjA5ODA4OTc2N30.i5OKPZC3swGLpiadEdCHuqOhZJWNlyg4FAA-Ndu4uL0',
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body := '{"refresh": true}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);
