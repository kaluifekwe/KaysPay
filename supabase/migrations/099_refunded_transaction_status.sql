-- A confirmed wallet reversal is semantically "refunded", not merely
-- "failed". Keep the immutable service_refunds audit row and metadata flag
-- as the idempotency evidence, while making the transaction status accurate
-- for customers, administrators, filters, reports, and notifications.

CREATE OR REPLACE FUNCTION public.refund_service_transaction_confirmed(
  p_tx_id UUID,
  p_reason TEXT,
  p_origin TEXT DEFAULT 'automatic'
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user_id UUID;
  v_amount BIGINT;
  v_status TEXT;
  v_type TEXT;
  v_refunded BOOLEAN;
  v_wallet_updated INTEGER := 0;
  v_reason TEXT := left(COALESCE(NULLIF(trim(p_reason), ''), 'provider_error'), 500);
BEGIN
  IF p_origin NOT IN ('automatic','reconcile','webhook','admin','legacy') THEN
    RAISE EXCEPTION 'INVALID_REFUND_ORIGIN';
  END IF;

  SELECT user_id, amount_ngn, status, type, COALESCE((metadata->>'refunded')::BOOLEAN, FALSE)
    INTO v_user_id, v_amount, v_status, v_type, v_refunded
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

  UPDATE public.wallets SET balance = balance + v_amount, updated_at = now()
  WHERE user_id = v_user_id;
  GET DIAGNOSTICS v_wallet_updated = ROW_COUNT;
  IF v_wallet_updated <> 1 THEN RETURN FALSE; END IF;

  UPDATE public.transactions
  SET status = 'refunded',
      metadata = COALESCE(metadata, '{}'::JSONB)
        || jsonb_build_object('failure_reason', v_reason, 'refunded', true)
  WHERE id = p_tx_id;

  INSERT INTO public.service_refunds(transaction_id, user_id, amount_kobo, reason, origin, refund_mode)
  VALUES (p_tx_id, v_user_id, v_amount, v_reason, p_origin, 'pending')
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
  v_status TEXT;
  v_type TEXT;
  v_refunded BOOLEAN;
  v_wallet_updated INTEGER := 0;
  v_reason TEXT := left(COALESCE(NULLIF(trim(p_reason), ''), 'service_not_delivered'), 500);
BEGIN
  IF p_origin NOT IN ('automatic','reconcile','webhook','admin','legacy') THEN
    RAISE EXCEPTION 'INVALID_REFUND_ORIGIN';
  END IF;
  SELECT user_id, amount_ngn, status, type, COALESCE((metadata->>'refunded')::BOOLEAN, FALSE)
    INTO v_user_id, v_amount, v_status, v_type, v_refunded
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

  UPDATE public.wallets SET balance = balance + v_amount, updated_at = now() WHERE user_id = v_user_id;
  GET DIAGNOSTICS v_wallet_updated = ROW_COUNT;
  IF v_wallet_updated <> 1 THEN RETURN FALSE; END IF;
  UPDATE public.transactions
  SET status = 'refunded', metadata = COALESCE(metadata, '{}'::JSONB)
    || jsonb_build_object('failure_reason', v_reason, 'refunded', true)
  WHERE id = p_tx_id;
  INSERT INTO public.service_refunds(
    transaction_id, user_id, amount_kobo, reason, origin, refund_mode
  ) VALUES (p_tx_id, v_user_id, v_amount, v_reason, p_origin, 'completed')
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

-- Normalize only transactions backed by immutable refund evidence. Disable
-- the notification trigger inside this migration transaction so historical
-- users do not receive a duplicate refund notification during the backfill.
ALTER TABLE public.transactions DISABLE TRIGGER trg_notify_on_transaction;
UPDATE public.transactions AS t
SET status = 'refunded'
WHERE t.status = 'failed'
  AND COALESCE((t.metadata->>'refunded')::BOOLEAN, FALSE)
  AND EXISTS (SELECT 1 FROM public.service_refunds r WHERE r.transaction_id = t.id);
ALTER TABLE public.transactions ENABLE TRIGGER trg_notify_on_transaction;

CREATE OR REPLACE FUNCTION public.admin_dashboard_report(p_start TIMESTAMPTZ, p_end TIMESTAMPTZ)
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'total_users', (SELECT count(*) FROM public.users),
    'new_users_in_range', (SELECT count(*) FROM public.users WHERE created_at >= p_start AND created_at < p_end),
    'orders_in_range', (SELECT count(*) FROM public.transactions WHERE created_at >= p_start AND created_at < p_end),
    'orders_completed_in_range', (SELECT count(*) FROM public.transactions WHERE status = 'completed' AND created_at >= p_start AND created_at < p_end),
    'orders_failed_in_range', (SELECT count(*) FROM public.transactions WHERE status = 'failed' AND COALESCE(metadata->>'refunded','') <> 'true' AND created_at >= p_start AND created_at < p_end),
    'orders_refunded_in_range', (SELECT count(*) FROM public.transactions WHERE (status = 'refunded' OR (status = 'failed' AND metadata->>'refunded' = 'true')) AND created_at >= p_start AND created_at < p_end),
    'volume_kobo_in_range', (SELECT COALESCE(sum(amount_ngn),0) FROM public.transactions WHERE status = 'completed' AND created_at >= p_start AND created_at < p_end),
    'services', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('type', s.type, 'order_count', s.cnt, 'volume_kobo', s.vol) ORDER BY s.vol DESC), '[]'::jsonb)
      FROM (
        SELECT type, count(*) AS cnt, sum(amount_ngn) AS vol
        FROM public.transactions
        WHERE status = 'completed' AND created_at >= p_start AND created_at < p_end
        GROUP BY type
      ) s
    )
  )
$$;
REVOKE EXECUTE ON FUNCTION public.admin_dashboard_report(TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_dashboard_report(TIMESTAMPTZ, TIMESTAMPTZ) TO service_role;

