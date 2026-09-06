-- Creator/promo-code attribution. Deliberately NOT built on the existing
-- onboarding_journey_state/acquisition_source pipeline (migrations 148/149)
-- even though that already has an acquisition_source filter -- that system
-- auto-deletes rows after 90-400 days (cleanup_onboarding_analytics) and its
-- own admin UI already labels its "stuck" numbers "Est." with a documented
-- linkage gap for real accounts. This feeds real creator-compensation
-- decisions, so it needs a permanent, exact record, computed straight from
-- the same authoritative tables admin_lifecycle_reminder_report uses for its
-- own "Verified" (non-estimated) numbers.

CREATE TABLE public.promo_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL,
  creator_name TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Case-insensitive uniqueness (a user typing "john10" and "JOHN10" must hit
-- the same code) without forcing a particular display casing on admin input.
CREATE UNIQUE INDEX promo_codes_code_unique ON public.promo_codes (upper(code));

ALTER TABLE public.promo_codes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.promo_codes FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.promo_codes TO service_role;

-- One row per user, ever -- a code is attributed permanently at signup and
-- can never be added or changed after the fact (which would make it trivial
-- to game: sign up, look at what's on offer elsewhere, backfill whichever
-- code benefits you most).
CREATE TABLE public.promo_code_redemptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  promo_code_id UUID NOT NULL REFERENCES public.promo_codes(id),
  user_id UUID NOT NULL UNIQUE REFERENCES public.users(id) ON DELETE CASCADE,
  redeemed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_promo_code_redemptions_code ON public.promo_code_redemptions(promo_code_id);

ALTER TABLE public.promo_code_redemptions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.promo_code_redemptions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.promo_code_redemptions TO service_role;

-- Called directly by the client right after signup (no edge function --
-- the project is at Supabase's 100-function cap, and this needs no secret,
-- no provider call, nothing an edge function would add). Uses auth.uid()
-- rather than a client-supplied user_id so a signed-in user can only ever
-- redeem a code for their OWN account, never anyone else's, regardless of
-- what this function is called with. Never raises on a bad/duplicate code --
-- a wrong promo code must never be able to block account creation, which
-- has already completed by the time this runs.
CREATE OR REPLACE FUNCTION public.redeem_promo_code(p_code TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_code_id UUID;
  v_already UUID;
BEGIN
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_authenticated');
  END IF;

  SELECT id INTO v_already FROM public.promo_code_redemptions WHERE user_id = v_user_id;
  IF v_already IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'already_redeemed');
  END IF;

  SELECT id INTO v_code_id FROM public.promo_codes
   WHERE upper(code) = upper(trim(p_code)) AND active = true;
  IF v_code_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_code');
  END IF;

  INSERT INTO public.promo_code_redemptions (promo_code_id, user_id) VALUES (v_code_id, v_user_id);
  RETURN jsonb_build_object('ok', true);
EXCEPTION WHEN unique_violation THEN
  -- Raced a concurrent redemption attempt for the same account.
  RETURN jsonb_build_object('ok', false, 'error', 'already_redeemed');
END;
$$;

REVOKE ALL ON FUNCTION public.redeem_promo_code(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.redeem_promo_code(TEXT) TO authenticated;

-- Admin report: for every code, the real (not estimated) funnel plus real
-- naira volumes -- exactly what's needed to decide creator compensation.
-- "Purchased" mirrors the same exclusion list update_onboarding_financial_
-- milestone (migration 149) already uses for its own first_purchase_at
-- milestone, plus wallet_correction (migration 218, never a real purchase).
CREATE OR REPLACE FUNCTION public.admin_list_promo_codes()
RETURNS TABLE (
  id UUID,
  code TEXT,
  creator_name TEXT,
  active BOOLEAN,
  created_at TIMESTAMPTZ,
  registered BIGINT,
  kyc_verified BIGINT,
  funded BIGINT,
  purchased BIGINT,
  total_funded_kobo BIGINT,
  total_purchase_volume_kobo BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    pc.id, pc.code, pc.creator_name, pc.active, pc.created_at,
    count(r.user_id) AS registered,
    count(r.user_id) FILTER (WHERE uk.status = 'verified') AS kyc_verified,
    count(r.user_id) FILTER (WHERE funded_sum.total IS NOT NULL) AS funded,
    count(r.user_id) FILTER (WHERE purchased_sum.total IS NOT NULL) AS purchased,
    COALESCE(sum(funded_sum.total), 0)::BIGINT AS total_funded_kobo,
    COALESCE(sum(purchased_sum.total), 0)::BIGINT AS total_purchase_volume_kobo
  FROM public.promo_codes pc
  LEFT JOIN public.promo_code_redemptions r ON r.promo_code_id = pc.id
  LEFT JOIN public.user_kyc uk ON uk.user_id = r.user_id
  LEFT JOIN LATERAL (
    SELECT sum(t.amount_ngn) AS total
    FROM public.transactions t
    WHERE t.user_id = r.user_id AND t.type = 'wallet_fund' AND t.status = 'completed'
  ) funded_sum ON true
  LEFT JOIN LATERAL (
    SELECT sum(t.amount_ngn) AS total
    FROM public.transactions t
    WHERE t.user_id = r.user_id AND t.status = 'completed'
      AND t.type NOT IN ('wallet_fund','refund','withdrawal','card_fund','transfer','crypto_sell','wallet_correction')
  ) purchased_sum ON true
  GROUP BY pc.id, pc.code, pc.creator_name, pc.active, pc.created_at
  ORDER BY pc.created_at DESC;
$$;

REVOKE ALL ON FUNCTION public.admin_list_promo_codes() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_list_promo_codes() TO service_role;
