-- Extends the admin markup pricing (migration 112) to cable TV bouquets and
-- NIN/BVN services, plus a flat electricity convenience fee. Same "row
-- missing = unchanged behaviour" guarantee as 112 — nothing charges anyone
-- differently until an admin explicitly sets a value.

-- Cable TV bouquets are provider-scoped (gotv/dstv/startimes), not
-- network-scoped like data plans, so they get their own overrides table
-- rather than reusing vtu_plan_price_overrides (whose network column is
-- CHECK-constrained to phone networks).
CREATE TABLE public.vtu_cabletv_price_overrides (
  provider    TEXT NOT NULL CHECK (provider IN ('gotv', 'dstv', 'startimes')),
  plan_id     TEXT NOT NULL,
  price_kobo  BIGINT NOT NULL CHECK (price_kobo > 0),
  updated_by  UUID REFERENCES auth.users(id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, plan_id)
);
ALTER TABLE public.vtu_cabletv_price_overrides ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.vtu_cabletv_price_overrides FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.vtu_cabletv_price_overrides TO service_role;

CREATE OR REPLACE FUNCTION public.set_cabletv_price(
  p_admin_user_id UUID,
  p_provider TEXT,
  p_plan_id TEXT,
  p_price_kobo BIGINT
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_provider NOT IN ('gotv','dstv','startimes')
     OR length(p_plan_id) NOT BETWEEN 1 AND 160
     OR p_price_kobo <= 0 THEN
    RAISE EXCEPTION 'INVALID_CABLETV_PRICE';
  END IF;

  INSERT INTO public.vtu_cabletv_price_overrides(provider, plan_id, price_kobo, updated_by, updated_at)
  VALUES (p_provider, p_plan_id, p_price_kobo, p_admin_user_id, now())
  ON CONFLICT (provider, plan_id) DO UPDATE SET
    price_kobo = EXCLUDED.price_kobo, updated_by = EXCLUDED.updated_by, updated_at = now();

  INSERT INTO public.admin_actions(admin_user_id, action_type, target_type, target_id, metadata)
  VALUES (
    p_admin_user_id, 'cabletv_price_set', 'vtu_cabletv_price_overrides',
    concat(p_provider, ':', p_plan_id),
    jsonb_build_object('provider', p_provider, 'plan_id', p_plan_id, 'price_kobo', p_price_kobo)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.clear_cabletv_price(
  p_admin_user_id UUID,
  p_provider TEXT,
  p_plan_id TEXT
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  DELETE FROM public.vtu_cabletv_price_overrides
  WHERE provider = p_provider AND plan_id = p_plan_id;

  INSERT INTO public.admin_actions(admin_user_id, action_type, target_type, target_id, metadata)
  VALUES (
    p_admin_user_id, 'cabletv_price_cleared', 'vtu_cabletv_price_overrides',
    concat(p_provider, ':', p_plan_id),
    jsonb_build_object('provider', p_provider, 'plan_id', p_plan_id)
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.set_cabletv_price(UUID,TEXT,TEXT,BIGINT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.clear_cabletv_price(UUID,TEXT,TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_cabletv_price(UUID,TEXT,TEXT,BIGINT) TO service_role;
GRANT EXECUTE ON FUNCTION public.clear_cabletv_price(UUID,TEXT,TEXT) TO service_role;

-- NIN/BVN provider cost: unlike VTUnaija's live-synced catalog, Prembly and
-- CheckMyNINBVN don't expose a fetchable per-call price — this is a manually
-- maintained reference number (what they actually bill us) so the admin
-- panel can show "provider cost + markup = customer pays" the same way data
-- plans do. price_kobo (the final customer price) keeps its existing meaning
-- and existing readers (nin-verify, bvn-verify, nin-modify, nin-validate)
-- need no changes at all.
ALTER TABLE public.service_pricing
  ADD COLUMN provider_cost_kobo BIGINT NOT NULL DEFAULT 0 CHECK (provider_cost_kobo >= 0);

CREATE OR REPLACE FUNCTION public.set_service_price(
  p_admin_user_id UUID,
  p_service_key TEXT,
  p_price_kobo BIGINT,
  p_provider_cost_kobo BIGINT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_service_key NOT IN (
       'nin_verify_regular', 'nin_verify_card', 'nin_modification',
       'nin_validation', 'bvn_verify_regular', 'bvn_verify_card'
     )
     OR p_price_kobo <= 0
     OR (p_provider_cost_kobo IS NOT NULL AND p_provider_cost_kobo < 0) THEN
    RAISE EXCEPTION 'INVALID_SERVICE_PRICE';
  END IF;

  INSERT INTO public.service_pricing(service_key, price_kobo, provider_cost_kobo, updated_by, updated_at)
  VALUES (p_service_key, p_price_kobo, COALESCE(p_provider_cost_kobo, 0), p_admin_user_id, now())
  ON CONFLICT (service_key) DO UPDATE SET
    price_kobo = EXCLUDED.price_kobo,
    provider_cost_kobo = COALESCE(p_provider_cost_kobo, public.service_pricing.provider_cost_kobo),
    updated_by = EXCLUDED.updated_by, updated_at = now();

  INSERT INTO public.admin_actions(admin_user_id, action_type, target_type, target_id, metadata)
  VALUES (
    p_admin_user_id, 'service_price_set', 'service_pricing', p_service_key,
    jsonb_build_object('service_key', p_service_key, 'price_kobo', p_price_kobo, 'provider_cost_kobo', p_provider_cost_kobo)
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.set_service_price(UUID,TEXT,BIGINT,BIGINT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_service_price(UUID,TEXT,BIGINT,BIGINT) TO service_role;

-- Electricity has no fixed provider price at all (the customer picks any
-- top-up amount and, today, the DISCO credits that exact amount) — so
-- there's nothing to "mark up" the way data/cable plans work. Instead this
-- is a single flat convenience fee added on top of whatever the customer
-- enters, the same way most Nigerian bill-pay apps handle this. Singleton
-- row (id always true) since it's one global fee, not per-DISCO.
CREATE TABLE public.electricity_fee_config (
  id          BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
  fee_kobo    BIGINT NOT NULL DEFAULT 0 CHECK (fee_kobo >= 0),
  updated_by  UUID REFERENCES auth.users(id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.electricity_fee_config ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.electricity_fee_config FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.electricity_fee_config TO service_role;

-- Seeded at zero so nothing changes on deploy until an admin sets a fee.
INSERT INTO public.electricity_fee_config (id, fee_kobo) VALUES (true, 0)
ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.set_electricity_fee(
  p_admin_user_id UUID,
  p_fee_kobo BIGINT
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_fee_kobo < 0 THEN
    RAISE EXCEPTION 'INVALID_ELECTRICITY_FEE';
  END IF;

  UPDATE public.electricity_fee_config
  SET fee_kobo = p_fee_kobo, updated_by = p_admin_user_id, updated_at = now()
  WHERE id = true;

  INSERT INTO public.admin_actions(admin_user_id, action_type, target_type, target_id, metadata)
  VALUES (
    p_admin_user_id, 'electricity_fee_set', 'electricity_fee_config', 'electricity_fee_config',
    jsonb_build_object('fee_kobo', p_fee_kobo)
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.set_electricity_fee(UUID,BIGINT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_electricity_fee(UUID,BIGINT) TO service_role;
