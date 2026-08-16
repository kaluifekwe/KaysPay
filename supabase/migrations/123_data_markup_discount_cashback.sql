-- Phase 2 of the automatic data markup engine (migration 122): compute a
-- discount and a cashback amount alongside the markup, both as a percentage
-- of that SAME plan's own markup — never a flat naira figure or a percentage
-- of price, so neither can ever push the charge below provider cost
-- regardless of plan size.
--
-- Scope, deliberately narrow: the discount goes live for real — the price
-- customers are actually charged (computed_price_kobo) becomes list price
-- minus discount, same safety guarantee as before (can only shrink margin,
-- discount_percent_of_markup is capped at 100 so it can reach cost but never
-- go below it). The cashback amount is computed and stored here too, but
-- there is deliberately no balance/ledger yet to credit it into — that is
-- its own separate, higher-stakes piece (crediting a real balance,
-- redemption, proportional refunds). Advertising a cashback amount to
-- customers before there's a real balance to honor it would be a trust
-- problem, not just a technical one — so this stays server-side/admin-
-- visible only until that ledger exists.

ALTER TABLE public.data_pricing_engine_config
  ADD COLUMN IF NOT EXISTS discount_percent_of_markup NUMERIC NOT NULL DEFAULT 30
    CHECK (discount_percent_of_markup BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS cashback_percent_of_markup NUMERIC NOT NULL DEFAULT 10
    CHECK (cashback_percent_of_markup BETWEEN 0 AND 100);

ALTER TABLE public.vtunaija_data_catalog
  ADD COLUMN IF NOT EXISTS computed_list_price_kobo BIGINT,
  ADD COLUMN IF NOT EXISTS computed_discount_kobo BIGINT,
  ADD COLUMN IF NOT EXISTS computed_cashback_kobo BIGINT;

DROP FUNCTION IF EXISTS public.set_data_pricing_engine_config(UUID, BOOLEAN, BOOLEAN, NUMERIC, NUMERIC, BIGINT);

CREATE OR REPLACE FUNCTION public.set_data_pricing_engine_config(
  p_admin_user_id UUID,
  p_enabled BOOLEAN,
  p_value_density_enabled BOOLEAN,
  p_value_density_max_adjust_percent NUMERIC,
  p_value_density_price_window_percent NUMERIC,
  p_min_markup_floor_kobo BIGINT,
  p_discount_percent_of_markup NUMERIC,
  p_cashback_percent_of_markup NUMERIC
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_value_density_max_adjust_percent NOT BETWEEN 0 AND 100
     OR p_value_density_price_window_percent <= 0 OR p_value_density_price_window_percent > 50
     OR p_min_markup_floor_kobo < 0
     OR p_discount_percent_of_markup NOT BETWEEN 0 AND 100
     OR p_cashback_percent_of_markup NOT BETWEEN 0 AND 100 THEN
    RAISE EXCEPTION 'INVALID_PRICING_ENGINE_CONFIG';
  END IF;

  UPDATE public.data_pricing_engine_config SET
    enabled = p_enabled,
    value_density_enabled = p_value_density_enabled,
    value_density_max_adjust_percent = p_value_density_max_adjust_percent,
    value_density_price_window_percent = p_value_density_price_window_percent,
    min_markup_floor_kobo = p_min_markup_floor_kobo,
    discount_percent_of_markup = p_discount_percent_of_markup,
    cashback_percent_of_markup = p_cashback_percent_of_markup,
    updated_by = p_admin_user_id, updated_at = now()
  WHERE id = true;

  INSERT INTO public.admin_actions(admin_user_id, action_type, target_type, target_id, metadata)
  VALUES (
    p_admin_user_id, 'data_pricing_engine_config_set', 'data_pricing_engine_config', 'singleton',
    jsonb_build_object(
      'enabled', p_enabled, 'value_density_enabled', p_value_density_enabled,
      'value_density_max_adjust_percent', p_value_density_max_adjust_percent,
      'value_density_price_window_percent', p_value_density_price_window_percent,
      'min_markup_floor_kobo', p_min_markup_floor_kobo,
      'discount_percent_of_markup', p_discount_percent_of_markup,
      'cashback_percent_of_markup', p_cashback_percent_of_markup
    )
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.set_data_pricing_engine_config(UUID,BOOLEAN,BOOLEAN,NUMERIC,NUMERIC,BIGINT,NUMERIC,NUMERIC) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_data_pricing_engine_config(UUID,BOOLEAN,BOOLEAN,NUMERIC,NUMERIC,BIGINT,NUMERIC,NUMERIC) TO service_role;
