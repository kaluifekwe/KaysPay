-- Defense-in-depth for vuln-0005 (2026-08-20 Strix pentest): even with
-- foreign-number-cancel's own check now in place, this puts the same rule
-- directly in the RPC that actually moves money, so no future call site
-- (a new edge function, an admin tool, a bug in a later change) can refund
-- a foreign_number transaction whose OTP has already been delivered —
-- exactly the state foreign-number-reconcile already treats as
-- non-refundable ("SMSPVA charged us, do not refund").
CREATE OR REPLACE FUNCTION public.refund_completed_service_transaction_confirmed(
  p_tx_id UUID,
  p_reason TEXT,
  p_origin TEXT DEFAULT 'automatic'
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user_id UUID;
  v_amount BIGINT;
  v_cashback_used BIGINT;
  v_wallet_amount BIGINT;
  v_status TEXT;
  v_type TEXT;
  v_metadata JSONB;
  v_refunded BOOLEAN;
  v_wallet_updated INTEGER := 0;
  v_reason TEXT := left(COALESCE(NULLIF(trim(p_reason), ''), 'service_not_delivered'), 500);
BEGIN
  IF p_origin NOT IN ('automatic','reconcile','webhook','admin','legacy') THEN
    RAISE EXCEPTION 'INVALID_REFUND_ORIGIN';
  END IF;
  SELECT user_id, amount_ngn, status, type, metadata, COALESCE((metadata->>'refunded')::BOOLEAN, FALSE), COALESCE(cashback_used_kobo, 0)
    INTO v_user_id, v_amount, v_status, v_type, v_metadata, v_refunded, v_cashback_used
    FROM public.transactions WHERE id = p_tx_id FOR UPDATE;
  IF v_user_id IS NULL THEN RETURN FALSE; END IF;
  IF v_type NOT IN (
    'airtime','data','bill','exam_pin','esim','foreign_number',
    'nin_verification','nin_validation','bvn_verification',
    'nin_name_modification','nin_phone_modification','nin_address_modification',
    'transfer'
  ) THEN RETURN FALSE; END IF;
  IF v_refunded THEN
    RETURN EXISTS (SELECT 1 FROM public.service_refunds WHERE transaction_id = p_tx_id);
  END IF;
  IF v_type = 'foreign_number'
     AND (
       COALESCE((v_metadata->>'code_received')::BOOLEAN, FALSE)
       OR NULLIF(v_metadata->>'code', '') IS NOT NULL
     ) THEN
    RETURN FALSE;
  END IF;
  IF v_status <> 'completed' OR v_amount IS NULL OR v_amount <= 0 THEN RETURN FALSE; END IF;

  v_wallet_amount := v_amount - v_cashback_used;

  UPDATE public.wallets SET balance = balance + v_wallet_amount, updated_at = now() WHERE user_id = v_user_id;
  GET DIAGNOSTICS v_wallet_updated = ROW_COUNT;
  IF v_wallet_updated <> 1 THEN RETURN FALSE; END IF;
  UPDATE public.transactions
  SET status = 'refunded', metadata = COALESCE(metadata, '{}'::JSONB)
    || jsonb_build_object('failure_reason', v_reason, 'refunded', true)
  WHERE id = p_tx_id;
  INSERT INTO public.service_refunds(
    transaction_id, user_id, amount_kobo, reason, origin, refund_mode
  ) VALUES (p_tx_id, v_user_id, v_wallet_amount, v_reason, p_origin, 'completed')
  ON CONFLICT (transaction_id) DO NOTHING;
  UPDATE public.service_refund_recovery
  SET resolved_at = now(), resolution = 'refunded', last_attempt_at = now(), attempts = attempts + 1
  WHERE transaction_id = p_tx_id AND resolved_at IS NULL;
  RETURN TRUE;
END;
$$;
