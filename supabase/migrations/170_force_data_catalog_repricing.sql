-- Financial safety: stored catalogue prices are valid only when they were
-- produced by the current engine. Immediately reprice every existing row so
-- deployment does not depend on a later provider refresh.

ALTER TABLE public.vtunaija_data_catalog
  ADD COLUMN IF NOT EXISTS pricing_engine_version INTEGER NOT NULL DEFAULT 0;

UPDATE public.data_pricing_engine_config
SET value_density_enabled = false,
    value_density_max_adjust_percent = 0,
    discount_percent_of_markup = 0,
    cashback_percent_of_markup = 10,
    updated_at = now()
WHERE id = true;

WITH classified AS (
  SELECT
    c.id,
    c.reseller_kobo,
    b.markup_type,
    b.markup_value,
    b.min_markup_kobo,
    b.min_net_margin_kobo,
    cfg.min_markup_floor_kobo,
    cfg.cashback_percent_of_markup,
    CASE
      WHEN c.validity ~* '[0-9]+\s*day' THEN substring(c.validity FROM '([0-9]+)')::INTEGER
      WHEN c.validity ~* '[0-9]+\s*week' THEN substring(c.validity FROM '([0-9]+)')::INTEGER * 7
      WHEN c.validity ~* '[0-9]+\s*month' THEN substring(c.validity FROM '([0-9]+)')::INTEGER * 30
      ELSE NULL
    END AS parsed_validity_days
  FROM public.vtunaija_data_catalog c
  JOIN public.data_markup_brackets b
    ON c.reseller_kobo >= b.min_price_kobo AND c.reseller_kobo < b.max_price_kobo
  CROSS JOIN public.data_pricing_engine_config cfg
  WHERE cfg.id = true AND cfg.enabled = true
), protected AS (
  SELECT
    *,
    GREATEST(
      CASE WHEN markup_type = 'flat' THEN markup_value
           ELSE round(reseller_kobo::NUMERIC * markup_value / 10000)::BIGINT END,
      min_markup_kobo,
      min_markup_floor_kobo,
      ceil(min_net_margin_kobo::NUMERIC * 100 / (100 - cashback_percent_of_markup))::BIGINT
    ) + CASE
      WHEN parsed_validity_days IS NULL OR parsed_validity_days <= 7 THEN 0
      WHEN parsed_validity_days <= 14 THEN 500
      WHEN parsed_validity_days <= 30 THEN 1000
      ELSE 2000
    END AS final_markup_kobo
  FROM classified
), repriced AS (
  SELECT
    *,
    ceil((reseller_kobo + final_markup_kobo)::NUMERIC / 100)::BIGINT * 100 AS final_price_kobo,
    round((final_markup_kobo * cashback_percent_of_markup / 100)::NUMERIC / 100)::BIGINT * 100 AS final_cashback_kobo
  FROM protected
)
UPDATE public.vtunaija_data_catalog c
SET computed_markup_kobo = r.final_markup_kobo,
    computed_list_price_kobo = r.final_price_kobo,
    computed_discount_kobo = 0,
    computed_cashback_kobo = r.final_cashback_kobo,
    computed_price_kobo = r.final_price_kobo,
    validity_days = r.parsed_validity_days,
    validity_adjustment_kobo = r.final_markup_kobo - GREATEST(
      CASE WHEN r.markup_type = 'flat' THEN r.markup_value
           ELSE round(r.reseller_kobo::NUMERIC * r.markup_value / 10000)::BIGINT END,
      r.min_markup_kobo,
      r.min_markup_floor_kobo,
      ceil(r.min_net_margin_kobo::NUMERIC * 100 / (100 - r.cashback_percent_of_markup))::BIGINT
    ),
    requires_pricing_review = c.name !~* '[0-9]+(?:\.[0-9]+)?\s*(GB|MB)' OR r.parsed_validity_days IS NULL,
    pricing_review_reason = CASE
      WHEN c.name !~* '[0-9]+(?:\.[0-9]+)?\s*(GB|MB)' THEN 'Data volume could not be classified'
      WHEN r.parsed_validity_days IS NULL THEN 'Validity could not be classified'
      ELSE NULL
    END,
    pricing_engine_version = 2,
    updated_at = now()
FROM repriced r
WHERE c.id = r.id;

-- Anything outside configured brackets must fail closed rather than retain an
-- old or provider-cost fallback price.
UPDATE public.vtunaija_data_catalog
SET computed_markup_kobo = NULL,
    computed_list_price_kobo = NULL,
    computed_discount_kobo = NULL,
    computed_cashback_kobo = NULL,
    computed_price_kobo = NULL,
    pricing_engine_version = 0,
    requires_pricing_review = true,
    pricing_review_reason = 'No current pricing bracket matches this provider cost',
    updated_at = now()
WHERE pricing_engine_version <> 2;

CREATE INDEX IF NOT EXISTS idx_vtunaija_data_catalog_pricing_version
  ON public.vtunaija_data_catalog(network, pricing_engine_version)
  WHERE available = true;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.vtunaija_data_catalog
    WHERE pricing_engine_version = 2
      AND (computed_price_kobo IS NULL OR computed_price_kobo < reseller_kobo
           OR computed_discount_kobo <> 0)
  ) THEN
    RAISE EXCEPTION 'DATA_REPRICING_SAFETY_ASSERTION_FAILED';
  END IF;
END
$$;
