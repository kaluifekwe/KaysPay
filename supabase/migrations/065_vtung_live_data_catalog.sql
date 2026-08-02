-- Live VTU.ng reseller catalogue. Clients never access this table directly;
-- the authenticated vtu-data-catalog Edge Function returns validated rows.
CREATE TABLE IF NOT EXISTS public.vtung_data_catalog (
  id             TEXT PRIMARY KEY,
  network        TEXT NOT NULL CHECK (network IN ('mtn', 'airtel', 'glo')),
  variation_id   TEXT NOT NULL,
  name           TEXT NOT NULL,
  validity       TEXT NOT NULL,
  reseller_kobo  BIGINT NOT NULL CHECK (reseller_kobo > 0),
  available      BOOLEAN NOT NULL DEFAULT false,
  provider_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (network, variation_id)
);

CREATE INDEX IF NOT EXISTS idx_vtung_data_catalog_available
  ON public.vtung_data_catalog (network, reseller_kobo)
  WHERE available = true;

ALTER TABLE public.vtung_data_catalog ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.vtung_data_catalog FROM anon, authenticated;

-- Replace the complete provider snapshot atomically. A failed/empty Edge
-- Function fetch never calls this RPC, so the last known-good catalogue stays.
CREATE OR REPLACE FUNCTION public.replace_vtung_data_catalog(p_rows JSONB)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  IF jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) < 3 THEN
    RAISE EXCEPTION 'INVALID_CATALOG_SNAPSHOT';
  END IF;

  UPDATE public.vtung_data_catalog
  SET available = false, updated_at = now();

  INSERT INTO public.vtung_data_catalog (
    id, network, variation_id, name, validity, reseller_kobo,
    available, provider_seen_at, updated_at
  )
  SELECT
    r.id, r.network, r.variation_id, r.name, r.validity,
    r.reseller_kobo, r.available, now(), now()
  FROM jsonb_to_recordset(p_rows) AS r(
    id TEXT,
    network TEXT,
    variation_id TEXT,
    name TEXT,
    validity TEXT,
    reseller_kobo BIGINT,
    available BOOLEAN
  )
  WHERE r.network IN ('mtn', 'airtel', 'glo')
    AND r.variation_id ~ '^[0-9]+$'
    AND r.reseller_kobo BETWEEN 1 AND 10000000
    AND length(r.name) BETWEEN 1 AND 120
  ON CONFLICT (id) DO UPDATE SET
    network = EXCLUDED.network,
    variation_id = EXCLUDED.variation_id,
    name = EXCLUDED.name,
    validity = EXCLUDED.validity,
    reseller_kobo = EXCLUDED.reseller_kobo,
    available = EXCLUDED.available,
    provider_seen_at = now(),
    updated_at = now();

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.replace_vtung_data_catalog(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.replace_vtung_data_catalog(JSONB) TO service_role;

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

SELECT cron.unschedule('vtung-data-catalog-sync')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'vtung-data-catalog-sync');

SELECT cron.schedule(
  'vtung-data-catalog-sync',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://xswlrzhtxrzugoxdonjc.supabase.co/functions/v1/vtu-data-catalog',
    headers := jsonb_build_object(
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inhzd2xyemh0eHJ6dWdveGRvbmpjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI1MTM3NjcsImV4cCI6MjA5ODA4OTc2N30.i5OKPZC3swGLpiadEdCHuqOhZJWNlyg4FAA-Ndu4uL0',
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret')
    ),
    body := '{"refresh":true}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);
