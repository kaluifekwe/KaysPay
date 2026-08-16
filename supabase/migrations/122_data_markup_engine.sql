-- Automatic markup engine for VTUnaija data plans (all networks: mtn, glo,
-- 9mobile, airtel — one catalogue sync already covers all four in one pass,
-- so this applies to every network without per-network setup).
--
-- Two layers, computed fresh on every 5-minute catalogue sync:
-- 1. A price-bracket base markup, admin-configured (data_markup_brackets) —
--    e.g. "provider price 150-400 kobo... wait, naira -> flat X kobo markup"
--    or "1000-3000 naira -> Y basis points". Replaces manually pricing each
--    plan by hand; a brand-new plan the provider adds gets a sensible markup
--    on its very first sync, no admin action required.
-- 2. An optional value-density adjustment (data_pricing_engine_config) —
--    among plans on the same network priced within a narrow window of each
--    other, the one giving more data per naira gets LESS markup (it's your
--    best deal, keep it thin and competitive) and the weaker one gets MORE
--    (already a worse deal regardless of markup, so it can absorb it).
--    Bounded by min_markup_floor_kobo so an adjustment can only ever shrink
--    the margin, never erase or invert it — the base bracket markup is
--    always positive, this only shifts within it.
--
-- Existing vtu_plan_price_overrides (migration 112) stays the manual escape
-- hatch: an admin can still hand-price one specific plan (e.g. to correct a
-- provider catalogue anomaly), and that takes priority over the computed
-- price the same way it already takes priority over the raw provider cost.

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE public.data_markup_brackets (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  min_price_kobo BIGINT NOT NULL CHECK (min_price_kobo >= 0),
  max_price_kobo BIGINT NOT NULL CHECK (max_price_kobo > min_price_kobo),
  markup_type    TEXT NOT NULL CHECK (markup_type IN ('flat', 'percent')),
  -- 'flat': kobo added on top. 'percent': basis points of the provider price
  -- (1 basis point = 0.01%, so 350 = 3.5%).
  markup_value   BIGINT NOT NULL CHECK (markup_value > 0),
  price_range    INT8RANGE GENERATED ALWAYS AS (int8range(min_price_kobo, max_price_kobo, '[)')) STORED,
  updated_by     UUID REFERENCES auth.users(id),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Guarantees brackets can never overlap at the database level — an
  -- overlap would leave "which bracket applies" undefined, a real
  -- correctness bug for a pricing table, not just a UI nicety to enforce.
  CONSTRAINT data_markup_brackets_no_overlap EXCLUDE USING gist (price_range WITH &&)
);
ALTER TABLE public.data_markup_brackets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.data_markup_brackets FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.data_markup_brackets TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.data_markup_brackets_id_seq TO service_role;

-- Seed with sensible starting brackets (flat naira at the cheap end, where a
-- percentage would round to nothing meaningful; percentage above ~1000
-- naira, where a flat number would need constant re-tuning as provider
-- prices drift). Tune freely from the admin panel — this is just a starting
-- point, not a hardcoded rule.
INSERT INTO public.data_markup_brackets (min_price_kobo, max_price_kobo, markup_type, markup_value) VALUES
  (0,        15000,    'flat',    1200),  -- 0 - 150 naira -> +12 naira flat
  (15000,    40000,    'flat',    2000),  -- 150 - 400 naira -> +20 naira flat
  (40000,    100000,   'flat',    3500),  -- 400 - 1,000 naira -> +35 naira flat
  (100000,   300000,   'percent', 350),   -- 1,000 - 3,000 naira -> +3.5%
  (300000,   1000000,  'percent', 300),   -- 3,000 - 10,000 naira -> +3%
  (1000000,  999999900000, 'percent', 250); -- 10,000+ naira -> +2.5%

CREATE TABLE public.data_pricing_engine_config (
  id                                  BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
  enabled                             BOOLEAN NOT NULL DEFAULT true,
  value_density_enabled               BOOLEAN NOT NULL DEFAULT true,
  -- Maximum the value-density step can move markup, as a percent of the
  -- base bracket markup (e.g. 30 = the best-value sibling can drop as low
  -- as 70% of base, the weakest can rise as high as 130% of base).
  value_density_max_adjust_percent    NUMERIC NOT NULL DEFAULT 30 CHECK (value_density_max_adjust_percent BETWEEN 0 AND 100),
  -- Two plans on the same network are "siblings" for comparison when their
  -- provider prices are within this percent of each other.
  value_density_price_window_percent  NUMERIC NOT NULL DEFAULT 10 CHECK (value_density_price_window_percent > 0 AND value_density_price_window_percent <= 50),
  -- Hard floor: no computed markup is ever allowed below this, regardless
  -- of bracket or adjustment. Last-line defence against a misconfigured
  -- bracket or adjustment accidentally erasing margin on some plan.
  min_markup_floor_kobo               BIGINT NOT NULL DEFAULT 100 CHECK (min_markup_floor_kobo >= 0),
  updated_by                          UUID REFERENCES auth.users(id),
  updated_at                          TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.data_pricing_engine_config ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.data_pricing_engine_config FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.data_pricing_engine_config TO service_role;
INSERT INTO public.data_pricing_engine_config (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

-- Sync writes the computed price here alongside the raw provider cost
-- (reseller_kobo, unchanged). NULL until the first sync after this
-- migration runs; the existing reseller_kobo fallback in the read paths
-- covers that gap safely (never charges below cost either way).
ALTER TABLE public.vtunaija_data_catalog
  ADD COLUMN IF NOT EXISTS computed_markup_kobo BIGINT,
  ADD COLUMN IF NOT EXISTS computed_price_kobo BIGINT;

CREATE OR REPLACE FUNCTION public.upsert_data_markup_bracket(
  p_admin_user_id UUID,
  p_bracket_id BIGINT,
  p_min_price_kobo BIGINT,
  p_max_price_kobo BIGINT,
  p_markup_type TEXT,
  p_markup_value BIGINT
) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id BIGINT;
BEGIN
  IF p_markup_type NOT IN ('flat', 'percent')
     OR p_min_price_kobo < 0 OR p_max_price_kobo <= p_min_price_kobo
     OR p_markup_value <= 0 THEN
    RAISE EXCEPTION 'INVALID_MARKUP_BRACKET';
  END IF;

  IF p_bracket_id IS NULL THEN
    INSERT INTO public.data_markup_brackets
      (min_price_kobo, max_price_kobo, markup_type, markup_value, updated_by, updated_at)
    VALUES (p_min_price_kobo, p_max_price_kobo, p_markup_type, p_markup_value, p_admin_user_id, now())
    RETURNING id INTO v_id;
  ELSE
    UPDATE public.data_markup_brackets SET
      min_price_kobo = p_min_price_kobo, max_price_kobo = p_max_price_kobo,
      markup_type = p_markup_type, markup_value = p_markup_value,
      updated_by = p_admin_user_id, updated_at = now()
    WHERE id = p_bracket_id
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN RAISE EXCEPTION 'BRACKET_NOT_FOUND'; END IF;
  END IF;

  INSERT INTO public.admin_actions(admin_user_id, action_type, target_type, target_id, metadata)
  VALUES (
    p_admin_user_id, 'data_markup_bracket_set', 'data_markup_brackets', v_id::TEXT,
    jsonb_build_object(
      'min_price_kobo', p_min_price_kobo, 'max_price_kobo', p_max_price_kobo,
      'markup_type', p_markup_type, 'markup_value', p_markup_value
    )
  );
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_data_markup_bracket(
  p_admin_user_id UUID,
  p_bracket_id BIGINT
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  DELETE FROM public.data_markup_brackets WHERE id = p_bracket_id;
  INSERT INTO public.admin_actions(admin_user_id, action_type, target_type, target_id, metadata)
  VALUES (p_admin_user_id, 'data_markup_bracket_deleted', 'data_markup_brackets', p_bracket_id::TEXT, '{}');
END;
$$;

CREATE OR REPLACE FUNCTION public.set_data_pricing_engine_config(
  p_admin_user_id UUID,
  p_enabled BOOLEAN,
  p_value_density_enabled BOOLEAN,
  p_value_density_max_adjust_percent NUMERIC,
  p_value_density_price_window_percent NUMERIC,
  p_min_markup_floor_kobo BIGINT
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_value_density_max_adjust_percent NOT BETWEEN 0 AND 100
     OR p_value_density_price_window_percent <= 0 OR p_value_density_price_window_percent > 50
     OR p_min_markup_floor_kobo < 0 THEN
    RAISE EXCEPTION 'INVALID_PRICING_ENGINE_CONFIG';
  END IF;

  UPDATE public.data_pricing_engine_config SET
    enabled = p_enabled,
    value_density_enabled = p_value_density_enabled,
    value_density_max_adjust_percent = p_value_density_max_adjust_percent,
    value_density_price_window_percent = p_value_density_price_window_percent,
    min_markup_floor_kobo = p_min_markup_floor_kobo,
    updated_by = p_admin_user_id, updated_at = now()
  WHERE id = true;

  INSERT INTO public.admin_actions(admin_user_id, action_type, target_type, target_id, metadata)
  VALUES (
    p_admin_user_id, 'data_pricing_engine_config_set', 'data_pricing_engine_config', 'singleton',
    jsonb_build_object(
      'enabled', p_enabled, 'value_density_enabled', p_value_density_enabled,
      'value_density_max_adjust_percent', p_value_density_max_adjust_percent,
      'value_density_price_window_percent', p_value_density_price_window_percent,
      'min_markup_floor_kobo', p_min_markup_floor_kobo
    )
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.upsert_data_markup_bracket(UUID,BIGINT,BIGINT,BIGINT,TEXT,BIGINT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.delete_data_markup_bracket(UUID,BIGINT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.set_data_pricing_engine_config(UUID,BOOLEAN,BOOLEAN,NUMERIC,NUMERIC,BIGINT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_data_markup_bracket(UUID,BIGINT,BIGINT,BIGINT,TEXT,BIGINT) TO service_role;
GRANT EXECUTE ON FUNCTION public.delete_data_markup_bracket(UUID,BIGINT) TO service_role;
GRANT EXECUTE ON FUNCTION public.set_data_pricing_engine_config(UUID,BOOLEAN,BOOLEAN,NUMERIC,NUMERIC,BIGINT) TO service_role;
