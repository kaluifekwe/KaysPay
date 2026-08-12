-- Admin-settable custom pricing (2026-08-12): data plans and NIN/BVN
-- identity services. An override/row is OPTIONAL everywhere — missing means
-- "keep charging what's shipped today" (the provider's own price for data,
-- the existing hardcoded default for identity), so this migration changes
-- nothing about what any customer is charged until an admin explicitly sets
-- a price through the admin panel.

CREATE TABLE public.vtu_plan_price_overrides (
  provider    TEXT NOT NULL,
  network     TEXT NOT NULL,
  plan_id     TEXT NOT NULL,
  price_kobo  BIGINT NOT NULL CHECK (price_kobo > 0),
  updated_by  UUID REFERENCES auth.users(id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, network, plan_id)
);
ALTER TABLE public.vtu_plan_price_overrides ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.vtu_plan_price_overrides FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.vtu_plan_price_overrides TO service_role;

CREATE TABLE public.service_pricing (
  service_key TEXT PRIMARY KEY CHECK (service_key IN (
    'nin_verify_regular', 'nin_verify_card', 'nin_modification',
    'nin_validation', 'bvn_verify_regular', 'bvn_verify_card'
  )),
  price_kobo  BIGINT NOT NULL CHECK (price_kobo > 0),
  updated_by  UUID REFERENCES auth.users(id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.service_pricing ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.service_pricing FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.service_pricing TO service_role;

-- Seed with the prices already shipped in code today (see nin-verify,
-- bvn-verify, nin-modify, nin-validate) so nothing changes on deploy.
INSERT INTO public.service_pricing (service_key, price_kobo) VALUES
  ('nin_verify_regular', 50000),
  ('nin_verify_card', 70000),
  ('nin_modification', 1800000),
  ('nin_validation', 800000),
  ('bvn_verify_regular', 50000),
  ('bvn_verify_card', 70000)
ON CONFLICT (service_key) DO NOTHING;

-- Same shape/pattern as set_vtu_plan_control (migration 091): validate,
-- upsert, and log to admin_actions in one atomic call.
CREATE OR REPLACE FUNCTION public.set_vtu_plan_price(
  p_admin_user_id UUID,
  p_provider TEXT,
  p_network TEXT,
  p_plan_id TEXT,
  p_price_kobo BIGINT
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_provider <> 'vtunaija'
     OR p_network NOT IN ('mtn','glo','9mobile','airtel')
     OR length(p_plan_id) NOT BETWEEN 1 AND 160
     OR p_price_kobo <= 0 THEN
    RAISE EXCEPTION 'INVALID_VTU_PLAN_PRICE';
  END IF;

  INSERT INTO public.vtu_plan_price_overrides(provider, network, plan_id, price_kobo, updated_by, updated_at)
  VALUES (p_provider, p_network, p_plan_id, p_price_kobo, p_admin_user_id, now())
  ON CONFLICT (provider, network, plan_id) DO UPDATE SET
    price_kobo = EXCLUDED.price_kobo, updated_by = EXCLUDED.updated_by, updated_at = now();

  INSERT INTO public.admin_actions(admin_user_id, action_type, target_type, target_id, metadata)
  VALUES (
    p_admin_user_id, 'vtu_plan_price_set', 'vtu_plan_price_overrides',
    concat(p_network, ':', p_plan_id),
    jsonb_build_object('provider', p_provider, 'network', p_network, 'plan_id', p_plan_id, 'price_kobo', p_price_kobo)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.clear_vtu_plan_price(
  p_admin_user_id UUID,
  p_provider TEXT,
  p_network TEXT,
  p_plan_id TEXT
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  DELETE FROM public.vtu_plan_price_overrides
  WHERE provider = p_provider AND network = p_network AND plan_id = p_plan_id;

  INSERT INTO public.admin_actions(admin_user_id, action_type, target_type, target_id, metadata)
  VALUES (
    p_admin_user_id, 'vtu_plan_price_cleared', 'vtu_plan_price_overrides',
    concat(p_network, ':', p_plan_id),
    jsonb_build_object('provider', p_provider, 'network', p_network, 'plan_id', p_plan_id)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.set_service_price(
  p_admin_user_id UUID,
  p_service_key TEXT,
  p_price_kobo BIGINT
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_service_key NOT IN (
       'nin_verify_regular', 'nin_verify_card', 'nin_modification',
       'nin_validation', 'bvn_verify_regular', 'bvn_verify_card'
     )
     OR p_price_kobo <= 0 THEN
    RAISE EXCEPTION 'INVALID_SERVICE_PRICE';
  END IF;

  INSERT INTO public.service_pricing(service_key, price_kobo, updated_by, updated_at)
  VALUES (p_service_key, p_price_kobo, p_admin_user_id, now())
  ON CONFLICT (service_key) DO UPDATE SET
    price_kobo = EXCLUDED.price_kobo, updated_by = EXCLUDED.updated_by, updated_at = now();

  INSERT INTO public.admin_actions(admin_user_id, action_type, target_type, target_id, metadata)
  VALUES (
    p_admin_user_id, 'service_price_set', 'service_pricing', p_service_key,
    jsonb_build_object('service_key', p_service_key, 'price_kobo', p_price_kobo)
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.set_vtu_plan_price(UUID,TEXT,TEXT,TEXT,BIGINT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.clear_vtu_plan_price(UUID,TEXT,TEXT,TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.set_service_price(UUID,TEXT,BIGINT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_vtu_plan_price(UUID,TEXT,TEXT,TEXT,BIGINT) TO service_role;
GRANT EXECUTE ON FUNCTION public.clear_vtu_plan_price(UUID,TEXT,TEXT,TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.set_service_price(UUID,TEXT,BIGINT) TO service_role;
