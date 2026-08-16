-- Durable, immutable evidence for wallet reversals of service purchases.
-- Wallet funding is deliberately excluded: only transactions originally
-- debited by debit_for_service are eligible through the allowlisted callers.
CREATE TABLE public.service_refunds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID NOT NULL UNIQUE REFERENCES public.transactions(id),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  amount_kobo BIGINT NOT NULL CHECK (amount_kobo > 0),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  origin TEXT NOT NULL CHECK (origin IN ('automatic','reconcile','webhook','admin','legacy')),
  refund_mode TEXT NOT NULL CHECK (refund_mode IN ('pending','completed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.service_refund_recovery (
  transaction_id UUID PRIMARY KEY REFERENCES public.transactions(id),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  origin TEXT NOT NULL CHECK (origin IN ('automatic','reconcile','webhook','admin','legacy')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_attempt_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  resolution TEXT CHECK (resolution IN ('refunded','provider_completed','not_refundable')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.service_refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.service_refund_recovery ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.service_refunds, public.service_refund_recovery FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.service_refunds, public.service_refund_recovery TO service_role;

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
  SET status = 'failed',
      metadata = COALESCE(metadata, '{}'::JSONB)
        || jsonb_build_object('failure_reason', v_reason, 'refunded', true)
  WHERE id = p_tx_id;

  INSERT INTO public.service_refunds(transaction_id, user_id, amount_kobo, reason, origin)
  VALUES (p_tx_id, v_user_id, v_amount, v_reason, p_origin)
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
  SET status = 'failed', metadata = COALESCE(metadata, '{}'::JSONB)
    || jsonb_build_object('failure_reason', v_reason, 'refunded', true)
  WHERE id = p_tx_id;
  INSERT INTO public.service_refunds(transaction_id, user_id, amount_kobo, reason, origin)
  VALUES (p_tx_id, v_user_id, v_amount, v_reason, p_origin)
  ON CONFLICT (transaction_id) DO NOTHING;
  UPDATE public.service_refund_recovery
  SET resolved_at = now(), resolution = 'refunded', last_attempt_at = now(), attempts = attempts + 1
  WHERE transaction_id = p_tx_id AND resolved_at IS NULL;
  RETURN TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION public.enqueue_service_refund_recovery(
  p_tx_id UUID, p_reason TEXT, p_origin TEXT DEFAULT 'automatic', p_completed BOOLEAN DEFAULT FALSE
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_origin NOT IN ('automatic','reconcile','webhook','admin','legacy') THEN
    RAISE EXCEPTION 'INVALID_REFUND_ORIGIN';
  END IF;
  INSERT INTO public.service_refund_recovery(transaction_id, reason, origin, refund_mode)
  VALUES (
    p_tx_id, left(COALESCE(NULLIF(trim(p_reason), ''), 'provider_error'), 500), p_origin,
    CASE WHEN p_completed THEN 'completed' ELSE 'pending' END
  )
  ON CONFLICT (transaction_id) DO UPDATE SET
    reason = EXCLUDED.reason, origin = EXCLUDED.origin, refund_mode = EXCLUDED.refund_mode,
    attempts = public.service_refund_recovery.attempts + 1,
    last_attempt_at = now(), resolved_at = NULL, resolution = NULL;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.refund_service_transaction_confirmed(UUID,TEXT,TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.refund_completed_service_transaction_confirmed(UUID,TEXT,TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.enqueue_service_refund_recovery(UUID,TEXT,TEXT,BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refund_service_transaction_confirmed(UUID,TEXT,TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.refund_completed_service_transaction_confirmed(UUID,TEXT,TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.enqueue_service_refund_recovery(UUID,TEXT,TEXT,BOOLEAN) TO service_role;

-- Preserve the established RPC signatures for any older deployed function,
-- but route them through the confirmed/audited implementation too.
CREATE OR REPLACE FUNCTION public.refund_service_transaction(
  p_tx_id UUID, p_reason TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.refund_service_transaction_confirmed(p_tx_id, p_reason, 'legacy') THEN
    RAISE EXCEPTION 'SERVICE_REFUND_UNCONFIRMED';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.refund_completed_service_transaction(
  p_tx_id UUID, p_reason TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.refund_completed_service_transaction_confirmed(p_tx_id, p_reason, 'legacy') THEN
    RAISE EXCEPTION 'SERVICE_REFUND_UNCONFIRMED';
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.refund_service_transaction(UUID,TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.refund_completed_service_transaction(UUID,TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refund_service_transaction(UUID,TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.refund_completed_service_transaction(UUID,TEXT) TO service_role;

CREATE OR REPLACE FUNCTION public.reconcile_service_refund_recovery()
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r RECORD;
  v_status TEXT;
  v_refunded BOOLEAN;
  v_ok BOOLEAN;
  v_checked INTEGER := 0;
  v_completed INTEGER := 0;
  v_unresolved INTEGER := 0;
BEGIN
  FOR r IN
    SELECT * FROM public.service_refund_recovery
    WHERE resolved_at IS NULL
    ORDER BY created_at
    LIMIT 50
    FOR UPDATE SKIP LOCKED
  LOOP
    v_checked := v_checked + 1;
    SELECT status, COALESCE((metadata->>'refunded')::BOOLEAN, FALSE)
      INTO v_status, v_refunded FROM public.transactions WHERE id = r.transaction_id;

    IF v_refunded THEN
      UPDATE public.service_refund_recovery
      SET resolved_at = now(), resolution = 'refunded', attempts = attempts + 1, last_attempt_at = now()
      WHERE transaction_id = r.transaction_id;
      v_completed := v_completed + 1;
    ELSIF r.refund_mode = 'pending' AND v_status = 'pending' THEN
      v_ok := public.refund_service_transaction_confirmed(r.transaction_id, r.reason, 'reconcile');
      IF v_ok THEN v_completed := v_completed + 1; ELSE v_unresolved := v_unresolved + 1; END IF;
    ELSIF r.refund_mode = 'completed' AND v_status = 'completed' THEN
      v_ok := public.refund_completed_service_transaction_confirmed(r.transaction_id, r.reason, 'reconcile');
      IF v_ok THEN v_completed := v_completed + 1; ELSE v_unresolved := v_unresolved + 1; END IF;
    ELSIF r.refund_mode = 'pending' AND v_status = 'completed' THEN
      -- Provider completion won the race. Never reverse a delivered service
      -- merely because an earlier response path requested a pending refund.
      UPDATE public.service_refund_recovery
      SET resolved_at = now(), resolution = 'provider_completed', attempts = attempts + 1, last_attempt_at = now()
      WHERE transaction_id = r.transaction_id;
      v_completed := v_completed + 1;
    ELSE
      UPDATE public.service_refund_recovery
      SET resolved_at = now(), resolution = 'not_refundable', attempts = attempts + 1, last_attempt_at = now()
      WHERE transaction_id = r.transaction_id;
      PERFORM public.record_monitoring_alert(
        'service_refund_not_refundable', 'service_refund_not_refundable', 'critical',
        jsonb_build_object('status', COALESCE(v_status, 'missing'), 'refund_mode', r.refund_mode)
      );
      v_unresolved := v_unresolved + 1;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('checked', v_checked, 'resolved', v_completed, 'needs_review', v_unresolved);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.reconcile_service_refund_recovery() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_service_refund_recovery() TO service_role;

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;
SELECT cron.unschedule('service-refund-recovery')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'service-refund-recovery');
SELECT cron.schedule('service-refund-recovery', '* * * * *',
  'SELECT public.reconcile_service_refund_recovery()');
