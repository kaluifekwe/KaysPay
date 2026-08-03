-- Small lookup table mapping VTUnaija's numeric disco_name codes to their own
-- provider name strings. Electricity has no pricing to sync (the customer
-- enters the amount, like airtime) — this table exists ONLY so
-- vtu-purchase can resolve the app's existing DISCO id (see
-- VTUNAIJA_ELECTRICITY_NAME_MAP in _shared/vtu-catalog.ts) to VTUnaija's
-- current numeric code by matching on name. Never queried by the client.
CREATE TABLE IF NOT EXISTS public.vtunaija_electricity_catalog (
  disco_id   TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  available  BOOLEAN NOT NULL DEFAULT true,
  provider_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.vtunaija_electricity_catalog ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.vtunaija_electricity_catalog FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.replace_vtunaija_electricity_catalog(p_rows JSONB)
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

  UPDATE public.vtunaija_electricity_catalog
  SET available = false, updated_at = now();

  INSERT INTO public.vtunaija_electricity_catalog (
    disco_id, name, available, provider_seen_at, updated_at
  )
  SELECT r.disco_id, r.name, r.available, now(), now()
  FROM jsonb_to_recordset(p_rows) AS r(
    disco_id TEXT,
    name TEXT,
    available BOOLEAN
  )
  WHERE r.disco_id ~ '^[0-9]+$'
    AND length(r.name) BETWEEN 1 AND 150
  ON CONFLICT (disco_id) DO UPDATE SET
    name = EXCLUDED.name,
    available = EXCLUDED.available,
    provider_seen_at = now(),
    updated_at = now();

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.replace_vtunaija_electricity_catalog(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.replace_vtunaija_electricity_catalog(JSONB) TO service_role;
