-- Enforce verified KYC at the money boundary for virtual-account funding.
-- Provider transfers received for an existing unverified account are recorded
-- as compliance holds and are not added to the spendable wallet balance.

ALTER TABLE public.funding_events
  DROP CONSTRAINT IF EXISTS funding_events_status_check;
ALTER TABLE public.funding_events
  ADD CONSTRAINT funding_events_status_check
  CHECK (status IN ('received','credited','duplicate','held','unmatched','rejected','error'));

CREATE TABLE IF NOT EXISTS public.funding_compliance_holds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL CHECK (provider IN ('paystack','flutterwave')),
  provider_reference TEXT NOT NULL CHECK (length(provider_reference) BETWEEN 1 AND 200),
  amount_kobo BIGINT NOT NULL CHECK (amount_kobo > 0),
  currency TEXT NOT NULL DEFAULT 'NGN' CHECK (currency = 'NGN'),
  status TEXT NOT NULL DEFAULT 'held'
    CHECK (status IN ('held','released','refund_pending','refunded','manual_review')),
  reason TEXT NOT NULL DEFAULT 'kyc_required',
  source TEXT NOT NULL CHECK (source IN ('webhook','reconcile')),
  held_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at TIMESTAMPTZ,
  refund_requested_at TIMESTAMPTZ,
  refunded_at TIMESTAMPTZ,
  reviewed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  review_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(provider, provider_reference)
);

CREATE INDEX IF NOT EXISTS funding_compliance_holds_user_idx
  ON public.funding_compliance_holds(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS funding_compliance_holds_pending_idx
  ON public.funding_compliance_holds(status, held_at)
  WHERE status IN ('held','refund_pending','manual_review');

ALTER TABLE public.funding_compliance_holds ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.funding_compliance_holds FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.funding_compliance_holds TO service_role;

CREATE OR REPLACE FUNCTION public.hold_wallet_funding(
  p_user_id UUID,
  p_reference TEXT,
  p_amount BIGINT,
  p_source TEXT,
  p_event_source TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_hold_id UUID;
  v_inserted INTEGER := 0;
  v_credit JSONB;
BEGIN
  IF p_source NOT IN ('paystack','flutterwave') THEN RAISE EXCEPTION 'INVALID_FUNDING_SOURCE'; END IF;
  IF p_event_source NOT IN ('webhook','reconcile') THEN RAISE EXCEPTION 'INVALID_EVENT_SOURCE'; END IF;
  IF p_reference IS NULL OR length(trim(p_reference)) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'INVALID_REFERENCE'; END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'INVALID_AMOUNT'; END IF;

  -- Close the verify-vs-webhook race: if KYC became verified after the edge
  -- function's lookup, credit through the normal idempotent path instead of
  -- creating a hold that the just-completed release sweep could miss.
  IF EXISTS (
    SELECT 1 FROM public.user_kyc
    WHERE user_id = p_user_id AND status = 'verified'
  ) THEN
    v_credit := public.credit_wallet_funding(p_user_id, trim(p_reference), p_amount, p_source);
    RETURN jsonb_build_object(
      'held', false,
      'credited', COALESCE((v_credit->>'credited')::BOOLEAN, FALSE),
      'duplicate', NOT COALESCE((v_credit->>'credited')::BOOLEAN, FALSE)
    );
  END IF;

  INSERT INTO public.funding_compliance_holds(
    user_id, provider, provider_reference, amount_kobo, source
  ) VALUES (
    p_user_id, p_source, trim(p_reference), p_amount, p_event_source
  ) ON CONFLICT(provider, provider_reference) DO NOTHING
  RETURNING id INTO v_hold_id;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  IF v_inserted = 0 THEN
    SELECT id INTO v_hold_id
    FROM public.funding_compliance_holds
    WHERE provider = p_source AND provider_reference = trim(p_reference)
      AND user_id = p_user_id AND amount_kobo = p_amount;
    IF v_hold_id IS NULL THEN RAISE EXCEPTION 'REFERENCE_PAYLOAD_MISMATCH'; END IF;
  ELSE
    BEGIN
      INSERT INTO public.notifications(user_id, title, body, type, data)
      VALUES (
        p_user_id,
        'Funding received — KYC required',
        'We received ₦' || to_char((p_amount::NUMERIC / 100), 'FM999,999,990.00') ||
          '. Complete identity verification before it can be added to your wallet.',
        'funding',
        jsonb_build_object('compliance_hold_id', v_hold_id, 'status', 'held')
      );
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END IF;

  RETURN jsonb_build_object('held', true, 'duplicate', v_inserted = 0, 'hold_id', v_hold_id);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.hold_wallet_funding(UUID,TEXT,BIGINT,TEXT,TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hold_wallet_funding(UUID,TEXT,BIGINT,TEXT,TEXT)
  TO service_role;

CREATE OR REPLACE FUNCTION public.release_verified_funding_holds(p_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_hold RECORD;
  v_credit JSONB;
  v_released INTEGER := 0;
  v_duplicates INTEGER := 0;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.user_kyc
    WHERE user_id = p_user_id AND status = 'verified'
  ) THEN
    RAISE EXCEPTION 'KYC_NOT_VERIFIED';
  END IF;

  FOR v_hold IN
    SELECT id, provider, provider_reference, amount_kobo
    FROM public.funding_compliance_holds
    WHERE user_id = p_user_id AND status = 'held'
    ORDER BY held_at, id
    FOR UPDATE SKIP LOCKED
  LOOP
    v_credit := public.credit_wallet_funding(
      p_user_id, v_hold.provider_reference, v_hold.amount_kobo, v_hold.provider
    );

    UPDATE public.funding_compliance_holds
    SET status = 'released', released_at = now(), updated_at = now()
    WHERE id = v_hold.id AND status = 'held';

    UPDATE public.funding_events
    SET status = CASE WHEN COALESCE((v_credit->>'credited')::BOOLEAN, FALSE)
                        THEN 'credited' ELSE 'duplicate' END,
        error_code = NULL, processed_at = now(), updated_at = now()
    WHERE provider = v_hold.provider
      AND provider_reference = v_hold.provider_reference;

    IF COALESCE((v_credit->>'credited')::BOOLEAN, FALSE) THEN
      v_released := v_released + 1;
    ELSE
      v_duplicates := v_duplicates + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('released', v_released, 'duplicates', v_duplicates);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.release_verified_funding_holds(UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_verified_funding_holds(UUID)
  TO service_role;

-- Read-only service-role audit surface for pre-existing virtual accounts that
-- belong to users who are not currently verified.
CREATE OR REPLACE VIEW public.unverified_virtual_account_audit AS
SELECT va.user_id, va.provider, va.account_number, va.bank_name, va.created_at,
       COALESCE(k.status, 'unverified') AS kyc_status
FROM public.virtual_accounts va
LEFT JOIN public.user_kyc k ON k.user_id = va.user_id
WHERE COALESCE(k.status, 'unverified') <> 'verified';

REVOKE ALL ON public.unverified_virtual_account_audit FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.unverified_virtual_account_audit TO service_role;
