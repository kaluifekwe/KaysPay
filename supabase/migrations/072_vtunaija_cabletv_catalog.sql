-- Live VTUnaija cable TV plan catalogue. Mirrors 068_vtunaija_data_catalog.sql's
-- pattern exactly (atomic-replace RPC, same RLS/REVOKE model). SHOWMAX is
-- excluded (not currently a supported TVServiceProvider in the app).
CREATE TABLE IF NOT EXISTS public.vtunaija_cabletv_catalog (
  id               TEXT PRIMARY KEY,
  provider         TEXT NOT NULL CHECK (provider IN ('gotv', 'dstv', 'startimes')),
  cabletv_plan_id  TEXT NOT NULL,
  name             TEXT NOT NULL,
  validity         TEXT NOT NULL,
  reseller_kobo    BIGINT NOT NULL CHECK (reseller_kobo > 0),
  available        BOOLEAN NOT NULL DEFAULT false,
  provider_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, cabletv_plan_id)
);

CREATE INDEX IF NOT EXISTS idx_vtunaija_cabletv_catalog_available
  ON public.vtunaija_cabletv_catalog (provider, reseller_kobo)
  WHERE available = true;

ALTER TABLE public.vtunaija_cabletv_catalog ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.vtunaija_cabletv_catalog FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.replace_vtunaija_cabletv_catalog(p_rows JSONB)
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

  UPDATE public.vtunaija_cabletv_catalog
  SET available = false, updated_at = now();

  INSERT INTO public.vtunaija_cabletv_catalog (
    id, provider, cabletv_plan_id, name, validity, reseller_kobo,
    available, provider_seen_at, updated_at
  )
  SELECT
    r.id, r.provider, r.cabletv_plan_id, r.name, r.validity,
    r.reseller_kobo, r.available, now(), now()
  FROM jsonb_to_recordset(p_rows) AS r(
    id TEXT,
    provider TEXT,
    cabletv_plan_id TEXT,
    name TEXT,
    validity TEXT,
    reseller_kobo BIGINT,
    available BOOLEAN
  )
  WHERE r.provider IN ('gotv', 'dstv', 'startimes')
    AND r.cabletv_plan_id ~ '^[0-9]+$'
    AND r.reseller_kobo BETWEEN 1 AND 100000000
    AND length(r.name) BETWEEN 1 AND 150
  ON CONFLICT (id) DO UPDATE SET
    provider = EXCLUDED.provider,
    cabletv_plan_id = EXCLUDED.cabletv_plan_id,
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

REVOKE ALL ON FUNCTION public.replace_vtunaija_cabletv_catalog(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.replace_vtunaija_cabletv_catalog(JSONB) TO service_role;
