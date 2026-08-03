-- Live VTUnaija data-plan catalogue. Mirrors 065_vtung_live_data_catalog.sql's
-- pattern exactly (atomic-replace RPC, same RLS/REVOKE model) — a NEW table
-- rather than reusing vtung_data_catalog in place, because the real shape
-- differs: VTUnaija's /listdataplans/ returns network as a STRING name
-- ("MTN"/"GLO"/"AIRTEL"/"9MOBILE"), normalized here to lowercase to match
-- VTUNAIJA_NETWORK_IDS's keys; VTUnaija's own field is `data_plan_id`, not
-- VTU.ng's `variation_id`; and 9mobile is supported here (VTU.ng's table
-- excludes it). vtung_data_catalog stays untouched as a rollback asset.
CREATE TABLE IF NOT EXISTS public.vtunaija_data_catalog (
  id             TEXT PRIMARY KEY,
  network        TEXT NOT NULL CHECK (network IN ('mtn', 'glo', '9mobile', 'airtel')),
  data_plan_id   TEXT NOT NULL,
  name           TEXT NOT NULL,
  validity       TEXT NOT NULL,
  reseller_kobo  BIGINT NOT NULL CHECK (reseller_kobo > 0),
  available      BOOLEAN NOT NULL DEFAULT false,
  provider_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (network, data_plan_id)
);

CREATE INDEX IF NOT EXISTS idx_vtunaija_data_catalog_available
  ON public.vtunaija_data_catalog (network, reseller_kobo)
  WHERE available = true;

ALTER TABLE public.vtunaija_data_catalog ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.vtunaija_data_catalog FROM anon, authenticated;

-- Replace the complete provider snapshot atomically. A failed/empty Edge
-- Function fetch never calls this RPC, so the last known-good catalogue stays.
CREATE OR REPLACE FUNCTION public.replace_vtunaija_data_catalog(p_rows JSONB)
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

  UPDATE public.vtunaija_data_catalog
  SET available = false, updated_at = now();

  INSERT INTO public.vtunaija_data_catalog (
    id, network, data_plan_id, name, validity, reseller_kobo,
    available, provider_seen_at, updated_at
  )
  SELECT
    r.id, r.network, r.data_plan_id, r.name, r.validity,
    r.reseller_kobo, r.available, now(), now()
  FROM jsonb_to_recordset(p_rows) AS r(
    id TEXT,
    network TEXT,
    data_plan_id TEXT,
    name TEXT,
    validity TEXT,
    reseller_kobo BIGINT,
    available BOOLEAN
  )
  WHERE r.network IN ('mtn', 'glo', '9mobile', 'airtel')
    AND r.data_plan_id ~ '^[0-9]+$'
    AND r.reseller_kobo BETWEEN 1 AND 10000000
    AND length(r.name) BETWEEN 1 AND 120
  ON CONFLICT (id) DO UPDATE SET
    network = EXCLUDED.network,
    data_plan_id = EXCLUDED.data_plan_id,
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

REVOKE ALL ON FUNCTION public.replace_vtunaija_data_catalog(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.replace_vtunaija_data_catalog(JSONB) TO service_role;
