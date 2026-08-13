-- Extends the admin markup pricing (migrations 112/114) to Exam PINs.
-- vtunaija_exam_catalog.customer_kobo is re-synced every 15 minutes (see
-- vtunaija-exam-catalog's cron) to mirror the provider's own price exactly —
-- writing a markup into that column would just get silently overwritten on
-- the next sync, so this gets its own overrides table, same shape as cable
-- TV's, left untouched by the catalog sync. Missing row = unchanged
-- behaviour, same guarantee as every other pricing table.
CREATE TABLE public.vtu_exam_price_overrides (
  exam_id     TEXT PRIMARY KEY CHECK (exam_id IN (
    'waec', 'neco', 'nabteb', 'jamb', 'waec-registration', 'nbais'
  )),
  price_kobo  BIGINT NOT NULL CHECK (price_kobo > 0),
  updated_by  UUID REFERENCES auth.users(id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.vtu_exam_price_overrides ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.vtu_exam_price_overrides FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.vtu_exam_price_overrides TO service_role;

CREATE OR REPLACE FUNCTION public.set_exam_pin_price(
  p_admin_user_id UUID,
  p_exam_id TEXT,
  p_price_kobo BIGINT
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_exam_id NOT IN ('waec', 'neco', 'nabteb', 'jamb', 'waec-registration', 'nbais')
     OR p_price_kobo <= 0 THEN
    RAISE EXCEPTION 'INVALID_EXAM_PIN_PRICE';
  END IF;

  INSERT INTO public.vtu_exam_price_overrides(exam_id, price_kobo, updated_by, updated_at)
  VALUES (p_exam_id, p_price_kobo, p_admin_user_id, now())
  ON CONFLICT (exam_id) DO UPDATE SET
    price_kobo = EXCLUDED.price_kobo, updated_by = EXCLUDED.updated_by, updated_at = now();

  INSERT INTO public.admin_actions(admin_user_id, action_type, target_type, target_id, metadata)
  VALUES (
    p_admin_user_id, 'exam_pin_price_set', 'vtu_exam_price_overrides', p_exam_id,
    jsonb_build_object('exam_id', p_exam_id, 'price_kobo', p_price_kobo)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.clear_exam_pin_price(
  p_admin_user_id UUID,
  p_exam_id TEXT
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  DELETE FROM public.vtu_exam_price_overrides WHERE exam_id = p_exam_id;

  INSERT INTO public.admin_actions(admin_user_id, action_type, target_type, target_id, metadata)
  VALUES (
    p_admin_user_id, 'exam_pin_price_cleared', 'vtu_exam_price_overrides', p_exam_id,
    jsonb_build_object('exam_id', p_exam_id)
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.set_exam_pin_price(UUID,TEXT,BIGINT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.clear_exam_pin_price(UUID,TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_exam_pin_price(UUID,TEXT,BIGINT) TO service_role;
GRANT EXECUTE ON FUNCTION public.clear_exam_pin_price(UUID,TEXT) TO service_role;
