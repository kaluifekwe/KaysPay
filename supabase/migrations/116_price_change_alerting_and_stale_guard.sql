-- Phase 3 of the pricing security review: flag large admin price changes on
-- the existing Security Alerts dashboard (record_monitoring_alert, migration
-- 107 — already wired to kayspay-admin's SecurityAlertsPage and its email
-- pipeline), so a fat-finger price edit surfaces for review instead of
-- silently going live. Threshold is deliberately loose (more than doubled,
-- or cut by more than half) — wide enough to never nag on a normal
-- deliberate re-price, tight enough to always catch an extra-zero typo.
-- No behaviour changes for the price itself; this only ever adds a flag.

CREATE OR REPLACE FUNCTION public.set_vtu_plan_price(
  p_admin_user_id UUID,
  p_provider TEXT,
  p_network TEXT,
  p_plan_id TEXT,
  p_price_kobo BIGINT
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_old_price BIGINT;
BEGIN
  IF p_provider <> 'vtunaija'
     OR p_network NOT IN ('mtn','glo','9mobile','airtel')
     OR length(p_plan_id) NOT BETWEEN 1 AND 160
     OR p_price_kobo <= 0 THEN
    RAISE EXCEPTION 'INVALID_VTU_PLAN_PRICE';
  END IF;

  SELECT price_kobo INTO v_old_price FROM public.vtu_plan_price_overrides
   WHERE provider = p_provider AND network = p_network AND plan_id = p_plan_id;

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

  IF v_old_price IS NOT NULL AND (p_price_kobo > v_old_price * 2 OR p_price_kobo < v_old_price / 2) THEN
    PERFORM public.record_monitoring_alert(
      concat('price_change_data_', p_network, '_', p_plan_id),
      'large_price_change',
      'warning',
      jsonb_build_object('kind', 'data_plan', 'network', p_network, 'plan_id', p_plan_id,
        'old_price_kobo', v_old_price, 'new_price_kobo', p_price_kobo, 'changed_by', p_admin_user_id)
    );
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_cabletv_price(
  p_admin_user_id UUID,
  p_provider TEXT,
  p_plan_id TEXT,
  p_price_kobo BIGINT
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_old_price BIGINT;
BEGIN
  IF p_provider NOT IN ('gotv','dstv','startimes')
     OR length(p_plan_id) NOT BETWEEN 1 AND 160
     OR p_price_kobo <= 0 THEN
    RAISE EXCEPTION 'INVALID_CABLETV_PRICE';
  END IF;

  SELECT price_kobo INTO v_old_price FROM public.vtu_cabletv_price_overrides
   WHERE provider = p_provider AND plan_id = p_plan_id;

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

  IF v_old_price IS NOT NULL AND (p_price_kobo > v_old_price * 2 OR p_price_kobo < v_old_price / 2) THEN
    PERFORM public.record_monitoring_alert(
      concat('price_change_cabletv_', p_provider, '_', p_plan_id),
      'large_price_change',
      'warning',
      jsonb_build_object('kind', 'cabletv', 'provider', p_provider, 'plan_id', p_plan_id,
        'old_price_kobo', v_old_price, 'new_price_kobo', p_price_kobo, 'changed_by', p_admin_user_id)
    );
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_exam_pin_price(
  p_admin_user_id UUID,
  p_exam_id TEXT,
  p_price_kobo BIGINT
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_old_price BIGINT;
BEGIN
  IF p_exam_id NOT IN ('waec', 'neco', 'nabteb', 'jamb', 'waec-registration', 'nbais')
     OR p_price_kobo <= 0 THEN
    RAISE EXCEPTION 'INVALID_EXAM_PIN_PRICE';
  END IF;

  SELECT price_kobo INTO v_old_price FROM public.vtu_exam_price_overrides WHERE exam_id = p_exam_id;

  INSERT INTO public.vtu_exam_price_overrides(exam_id, price_kobo, updated_by, updated_at)
  VALUES (p_exam_id, p_price_kobo, p_admin_user_id, now())
  ON CONFLICT (exam_id) DO UPDATE SET
    price_kobo = EXCLUDED.price_kobo, updated_by = EXCLUDED.updated_by, updated_at = now();

  INSERT INTO public.admin_actions(admin_user_id, action_type, target_type, target_id, metadata)
  VALUES (
    p_admin_user_id, 'exam_pin_price_set', 'vtu_exam_price_overrides', p_exam_id,
    jsonb_build_object('exam_id', p_exam_id, 'price_kobo', p_price_kobo)
  );

  IF v_old_price IS NOT NULL AND (p_price_kobo > v_old_price * 2 OR p_price_kobo < v_old_price / 2) THEN
    PERFORM public.record_monitoring_alert(
      concat('price_change_exam_', p_exam_id),
      'large_price_change',
      'warning',
      jsonb_build_object('kind', 'exam_pin', 'exam_id', p_exam_id,
        'old_price_kobo', v_old_price, 'new_price_kobo', p_price_kobo, 'changed_by', p_admin_user_id)
    );
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_service_price(
  p_admin_user_id UUID,
  p_service_key TEXT,
  p_price_kobo BIGINT,
  p_provider_cost_kobo BIGINT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_old_price BIGINT;
BEGIN
  IF p_service_key NOT IN (
       'nin_verify_regular', 'nin_verify_card', 'nin_modification',
       'nin_validation', 'bvn_verify_regular', 'bvn_verify_card'
     )
     OR p_price_kobo <= 0
     OR (p_provider_cost_kobo IS NOT NULL AND p_provider_cost_kobo < 0) THEN
    RAISE EXCEPTION 'INVALID_SERVICE_PRICE';
  END IF;

  SELECT price_kobo INTO v_old_price FROM public.service_pricing WHERE service_key = p_service_key;

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

  IF v_old_price IS NOT NULL AND (p_price_kobo > v_old_price * 2 OR p_price_kobo < v_old_price / 2) THEN
    PERFORM public.record_monitoring_alert(
      concat('price_change_service_', p_service_key),
      'large_price_change',
      'warning',
      jsonb_build_object('kind', 'service', 'service_key', p_service_key,
        'old_price_kobo', v_old_price, 'new_price_kobo', p_price_kobo, 'changed_by', p_admin_user_id)
    );
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_electricity_fee(
  p_admin_user_id UUID,
  p_fee_kobo BIGINT
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_old_fee BIGINT;
BEGIN
  IF p_fee_kobo < 0 THEN
    RAISE EXCEPTION 'INVALID_ELECTRICITY_FEE';
  END IF;

  SELECT fee_kobo INTO v_old_fee FROM public.electricity_fee_config WHERE id = true;

  UPDATE public.electricity_fee_config
  SET fee_kobo = p_fee_kobo, updated_by = p_admin_user_id, updated_at = now()
  WHERE id = true;

  INSERT INTO public.admin_actions(admin_user_id, action_type, target_type, target_id, metadata)
  VALUES (
    p_admin_user_id, 'electricity_fee_set', 'electricity_fee_config', 'electricity_fee_config',
    jsonb_build_object('fee_kobo', p_fee_kobo)
  );

  -- Fee can legitimately be 0 (disabled) -> re-enabling from 0 would be a
  -- divide-by-zero on the ratio check, so it's excluded rather than guarded.
  IF v_old_fee IS NOT NULL AND v_old_fee > 0 AND (p_fee_kobo > v_old_fee * 2 OR p_fee_kobo < v_old_fee / 2) THEN
    PERFORM public.record_monitoring_alert(
      'price_change_electricity_fee',
      'large_price_change',
      'warning',
      jsonb_build_object('kind', 'electricity_fee',
        'old_fee_kobo', v_old_fee, 'new_fee_kobo', p_fee_kobo, 'changed_by', p_admin_user_id)
    );
  END IF;
END;
$$;
