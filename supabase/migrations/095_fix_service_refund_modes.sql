-- Repair the refund-mode audit/recovery fields introduced in migration 094.
-- Pending refunds can use the audit-table default; completed-service recovery
-- must explicitly record its distinct mode.
ALTER TABLE public.service_refunds
  ALTER COLUMN refund_mode SET DEFAULT 'pending';

ALTER TABLE public.service_refund_recovery
  ADD COLUMN IF NOT EXISTS refund_mode TEXT NOT NULL DEFAULT 'pending';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'service_refund_recovery_refund_mode_check'
      AND conrelid = 'public.service_refund_recovery'::regclass
  ) THEN
    ALTER TABLE public.service_refund_recovery
      ADD CONSTRAINT service_refund_recovery_refund_mode_check
      CHECK (refund_mode IN ('pending', 'completed'));
  END IF;
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

REVOKE EXECUTE ON FUNCTION public.refund_completed_service_transaction_confirmed(UUID,TEXT,TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refund_completed_service_transaction_confirmed(UUID,TEXT,TEXT)
  TO service_role;
