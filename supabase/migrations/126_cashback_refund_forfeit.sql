-- Phase 3, stage 3: refund policy. When a cashback-funded purchase is
-- refunded, only the wallet-funded portion is returned — the cashback
-- portion is forfeited, not restored to cashback_balance_kobo. Owner's
-- explicit decision: cashback is a promotional credit, and once redeemed
-- it's spent whether or not the purchase it funded goes on to succeed.
-- Simpler than a proportional split both ways, and there's nothing further
-- to record in cashback_ledger here — the 'redeemed' entry already written
-- at debit time (migration 125) still accurately reflects that the balance
-- was spent; refund just doesn't reverse it.
--
-- Both refund_service_transaction_confirmed (transaction still 'pending')
-- and refund_completed_service_transaction_confirmed (transaction already
-- 'completed', service turned out not to be delivered) get the same fix —
-- these are the only two refund paths in the app (see
-- _shared/service-refund.ts's confirmServiceRefund, called by every
-- service-purchase edge function). Same signatures as before, so a plain
-- CREATE OR REPLACE is enough — no DROP needed, unlike migration 125.

CREATE OR REPLACE FUNCTION public.refund_service_transaction_confirmed(
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
  v_refunded BOOLEAN;
  v_wallet_updated INTEGER := 0;
  v_reason TEXT := left(COALESCE(NULLIF(trim(p_reason), ''), 'provider_error'), 500);
BEGIN
  IF p_origin NOT IN ('automatic','reconcile','webhook','admin','legacy') THEN
    RAISE EXCEPTION 'INVALID_REFUND_ORIGIN';
  END IF;

  SELECT user_id, amount_ngn, status, type, COALESCE((metadata->>'refunded')::BOOLEAN, FALSE), COALESCE(cashback_used_kobo, 0)
    INTO v_user_id, v_amount, v_status, v_type, v_refunded, v_cashback_used
    FROM public.transactions WHERE id = p_tx_id FOR UPDATE;

  IF v_user_id IS NULL THEN RETURN FALSE; END IF;
  IF v_type NOT IN (
    'airtime','data','bill','exam_pin','esim','foreign_number',
    'nin_verification','nin_validation','bvn_verification',
    'nin_name_modification','nin_phone_modification','nin_address_modification'
  ) THEN RETURN FALSE; END IF;
  IF v_refunded THEN
    RETURN EXISTS (SELECT 1 FROM public.service_refunds WHERE transaction_id = p_tx_id);
  END IF;
  IF v_status <> 'pending' OR v_amount IS NULL OR v_amount <= 0 THEN RETURN FALSE; END IF;

  v_wallet_amount := v_amount - v_cashback_used;

  UPDATE public.wallets SET balance = balance + v_wallet_amount, updated_at = now()
  WHERE user_id = v_user_id;
  GET DIAGNOSTICS v_wallet_updated = ROW_COUNT;
  IF v_wallet_updated <> 1 THEN RETURN FALSE; END IF;

  UPDATE public.transactions
  SET status = 'refunded',
      metadata = COALESCE(metadata, '{}'::JSONB)
        || jsonb_build_object('failure_reason', v_reason, 'refunded', true)
  WHERE id = p_tx_id;

  INSERT INTO public.service_refunds(transaction_id, user_id, amount_kobo, reason, origin, refund_mode)
  VALUES (p_tx_id, v_user_id, v_wallet_amount, v_reason, p_origin, 'pending')
  ON CONFLICT (transaction_id) DO NOTHING;

  UPDATE public.service_refund_recovery
  SET resolved_at = now(), resolution = 'refunded', last_attempt_at = now(), attempts = attempts + 1
  WHERE transaction_id = p_tx_id AND resolved_at IS NULL;
  RETURN TRUE;
END;
$$;

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
  v_refunded BOOLEAN;
  v_wallet_updated INTEGER := 0;
  v_reason TEXT := left(COALESCE(NULLIF(trim(p_reason), ''), 'service_not_delivered'), 500);
BEGIN
  IF p_origin NOT IN ('automatic','reconcile','webhook','admin','legacy') THEN
    RAISE EXCEPTION 'INVALID_REFUND_ORIGIN';
  END IF;
  SELECT user_id, amount_ngn, status, type, COALESCE((metadata->>'refunded')::BOOLEAN, FALSE), COALESCE(cashback_used_kobo, 0)
    INTO v_user_id, v_amount, v_status, v_type, v_refunded, v_cashback_used
    FROM public.transactions WHERE id = p_tx_id FOR UPDATE;
  IF v_user_id IS NULL THEN RETURN FALSE; END IF;
  IF v_type NOT IN (
    'airtime','data','bill','exam_pin','esim','foreign_number',
    'nin_verification','nin_validation','bvn_verification',
    'nin_name_modification','nin_phone_modification','nin_address_modification'
  ) THEN RETURN FALSE; END IF;
  IF v_refunded THEN
    RETURN EXISTS (SELECT 1 FROM public.service_refunds WHERE transaction_id = p_tx_id);
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

REVOKE EXECUTE ON FUNCTION public.refund_service_transaction_confirmed(UUID,TEXT,TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.refund_completed_service_transaction_confirmed(UUID,TEXT,TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refund_service_transaction_confirmed(UUID,TEXT,TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.refund_completed_service_transaction_confirmed(UUID,TEXT,TEXT) TO service_role;
