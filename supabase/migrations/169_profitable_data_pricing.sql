-- Replace the discountable/value-density model with hybrid percentage +
-- naira floors. Each bracket also guarantees retained margin after cashback.

ALTER TABLE public.data_markup_brackets
  ADD COLUMN IF NOT EXISTS min_markup_kobo BIGINT NOT NULL DEFAULT 0 CHECK (min_markup_kobo >= 0),
  ADD COLUMN IF NOT EXISTS min_net_margin_kobo BIGINT NOT NULL DEFAULT 0 CHECK (min_net_margin_kobo >= 0);

ALTER TABLE public.data_markup_brackets
  ADD CONSTRAINT data_markup_brackets_net_not_above_gross
  CHECK (min_net_margin_kobo <= min_markup_kobo);

ALTER TABLE public.vtunaija_data_catalog
  ADD COLUMN IF NOT EXISTS normalized_data_mb NUMERIC,
  ADD COLUMN IF NOT EXISTS validity_days INTEGER,
  ADD COLUMN IF NOT EXISTS validity_adjustment_kobo BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS requires_pricing_review BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS pricing_review_reason TEXT;

-- Replace the old bands atomically. Half-open ranges make exactly N3,000 use
-- the N3,000-N7,500 band, where its gross floor is N150 (not about N50).
DELETE FROM public.data_markup_brackets;
INSERT INTO public.data_markup_brackets
  (min_price_kobo, max_price_kobo, markup_type, markup_value, min_markup_kobo, min_net_margin_kobo)
VALUES
  (0,       50000,        'percent', 800,  3000,  2500),
  (50000,   150000,       'percent', 600,  5000,  4500),
  (150000,  300000,       'percent', 500, 10000,  9000),
  (300000,  750000,       'percent', 500, 15000, 13500),
  (750000,  1500000,      'percent', 450, 30000, 27000),
  (1500000, 999999900000, 'percent', 400, 50000, 45000);

UPDATE public.data_pricing_engine_config
SET value_density_enabled = false,
    value_density_max_adjust_percent = 0,
    discount_percent_of_markup = 0,
    cashback_percent_of_markup = 10,
    updated_at = now()
WHERE id = true;

DROP FUNCTION IF EXISTS public.upsert_data_markup_bracket(UUID,BIGINT,BIGINT,BIGINT,TEXT,BIGINT);
CREATE FUNCTION public.upsert_data_markup_bracket(
  p_admin_user_id UUID,
  p_bracket_id BIGINT,
  p_min_price_kobo BIGINT,
  p_max_price_kobo BIGINT,
  p_markup_type TEXT,
  p_markup_value BIGINT,
  p_min_markup_kobo BIGINT,
  p_min_net_margin_kobo BIGINT
) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id BIGINT;
BEGIN
  IF p_markup_type NOT IN ('flat', 'percent')
     OR p_min_price_kobo < 0 OR p_max_price_kobo <= p_min_price_kobo
     OR p_markup_value <= 0 OR p_min_markup_kobo < 0
     OR p_min_net_margin_kobo < 0 OR p_min_net_margin_kobo > p_min_markup_kobo THEN
    RAISE EXCEPTION 'INVALID_MARKUP_BRACKET';
  END IF;

  IF p_bracket_id IS NULL THEN
    INSERT INTO public.data_markup_brackets
      (min_price_kobo, max_price_kobo, markup_type, markup_value,
       min_markup_kobo, min_net_margin_kobo, updated_by, updated_at)
    VALUES (p_min_price_kobo, p_max_price_kobo, p_markup_type, p_markup_value,
            p_min_markup_kobo, p_min_net_margin_kobo, p_admin_user_id, now())
    RETURNING id INTO v_id;
  ELSE
    UPDATE public.data_markup_brackets SET
      min_price_kobo = p_min_price_kobo, max_price_kobo = p_max_price_kobo,
      markup_type = p_markup_type, markup_value = p_markup_value,
      min_markup_kobo = p_min_markup_kobo, min_net_margin_kobo = p_min_net_margin_kobo,
      updated_by = p_admin_user_id, updated_at = now()
    WHERE id = p_bracket_id RETURNING id INTO v_id;
    IF v_id IS NULL THEN RAISE EXCEPTION 'BRACKET_NOT_FOUND'; END IF;
  END IF;

  INSERT INTO public.admin_actions(admin_user_id, action_type, target_type, target_id, metadata)
  VALUES (p_admin_user_id, 'data_markup_bracket_set', 'data_markup_brackets', v_id::TEXT,
    jsonb_build_object('min_price_kobo', p_min_price_kobo, 'max_price_kobo', p_max_price_kobo,
      'markup_type', p_markup_type, 'markup_value', p_markup_value,
      'min_markup_kobo', p_min_markup_kobo, 'min_net_margin_kobo', p_min_net_margin_kobo));
  RETURN v_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.upsert_data_markup_bracket(UUID,BIGINT,BIGINT,BIGINT,TEXT,BIGINT,BIGINT,BIGINT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_data_markup_bracket(UUID,BIGINT,BIGINT,BIGINT,TEXT,BIGINT,BIGINT,BIGINT) TO service_role;
