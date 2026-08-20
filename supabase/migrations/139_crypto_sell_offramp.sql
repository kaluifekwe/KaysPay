-- Replaces crypto Sell's mechanism entirely: instead of an internal Exchange
-- swap that credits the KaysPay wallet (record_crypto_sell_pending /
-- complete_crypto_sell / fail_crypto_sell, migration 119 — now unused, left
-- in place rather than dropped, same "keep it, just stop calling it"
-- pattern as migration 130's Transfer park), Sell now pays the customer's
-- bank account DIRECTLY via Quidax's Ramp off-ramp product, using Quidax's
-- own liquidity. The KaysPay wallet is never touched by a sale.
--
-- Owner decision, 2026-08-20: chosen specifically because KaysPay currently
-- has no float capital to keep a Flutterwave/Paystack payout balance funded
-- — off-ramp sidesteps that entirely for crypto proceeds, since Quidax
-- settles the payout itself.
--
-- No wallet credit anywhere in this flow, so there is also no automatic
-- refund path if a sale fails after the customer's crypto has already left
-- their sub-account (see record_monitoring_alert call in fail_crypto_sell_offramp)
-- — that gap is a known, accepted limitation of this first version, not an
-- oversight; a self-service refund flow (mirroring Buy's) is future work.

-- Step 1: record the sale as pending, before the customer's crypto has left
-- their sub-account. p_reference is Quidax's own off-ramp reference
-- (TRX-*); p_merchant_reference is ours — both stored, since Quidax's own
-- docs are inconsistent about which one their GET/webhook actually key on
-- (same ambiguity already hit with Buy — see crypto-buy-reconcile).
CREATE OR REPLACE FUNCTION public.record_crypto_sell_offramp_pending(
  p_user_id             UUID,
  p_asset               TEXT,
  p_crypto_micro        BIGINT,
  p_reference            TEXT,
  p_merchant_reference   TEXT,
  p_recipient_bank_name  TEXT,
  p_recipient_account_number TEXT,
  p_idempotency_key      TEXT
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tx_id UUID;
BEGIN
  IF p_crypto_micro IS NULL OR p_crypto_micro <= 0 OR p_reference IS NULL OR p_merchant_reference IS NULL THEN
    RAISE EXCEPTION 'INVALID_SELL';
  END IF;

  SELECT id INTO v_tx_id FROM transactions
   WHERE metadata->>'idempotency_key' = p_idempotency_key LIMIT 1;
  IF v_tx_id IS NOT NULL THEN
    RETURN v_tx_id;
  END IF;

  INSERT INTO transactions (user_id, type, recipient_phone, network, amount_ngn, status, metadata)
  VALUES (p_user_id, 'crypto_sell', p_asset, 'N/A', 0, 'pending',
          jsonb_build_object('asset', p_asset, 'crypto_micro', p_crypto_micro,
                              'quidax_reference', p_reference,
                              'quidax_merchant_reference', p_merchant_reference,
                              'recipient_bank_name', p_recipient_bank_name,
                              'recipient_account_number', p_recipient_account_number,
                              'settlement', 'offramp_direct',
                              'idempotency_key', p_idempotency_key))
  RETURNING id INTO v_tx_id;

  RETURN v_tx_id;
END;
$$;

-- Step 2: Quidax's off-ramp actually paid the bank account. Matched on
-- EITHER reference (mirrors crypto-buy-reconcile's "try both" discipline
-- rather than guessing which one the webhook/GET response actually uses).
-- No wallet movement — the money never entered KaysPay at all.
CREATE OR REPLACE FUNCTION public.complete_crypto_sell_offramp(
  p_reference TEXT,
  p_ngn_kobo  BIGINT
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tx_id  UUID;
  v_status TEXT;
BEGIN
  IF p_ngn_kobo IS NULL OR p_ngn_kobo <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT';
  END IF;

  SELECT id, status INTO v_tx_id, v_status
    FROM transactions
   WHERE type = 'crypto_sell'
     AND (metadata->>'quidax_reference' = p_reference OR metadata->>'quidax_merchant_reference' = p_reference)
   FOR UPDATE;

  IF v_tx_id IS NULL THEN
    RETURN NULL;
  END IF;
  IF v_status <> 'pending' THEN
    RETURN v_tx_id;
  END IF;

  UPDATE transactions
     SET status = 'completed',
         amount_ngn = p_ngn_kobo,
         completed_at = now(),
         metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('settled_ngn_kobo', p_ngn_kobo)
   WHERE id = v_tx_id;

  RETURN v_tx_id;
END;
$$;

-- Failure path: the customer's crypto may already have left their
-- sub-account by this point (it's sent to Quidax's deposit address before
-- the payout itself is confirmed) — there is nothing here to reverse
-- locally, so this raises a critical alert for manual follow-up rather than
-- silently failing.
CREATE OR REPLACE FUNCTION public.fail_crypto_sell_offramp(
  p_reference TEXT,
  p_reason    TEXT DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tx_id UUID;
BEGIN
  UPDATE transactions
     SET status = 'failed',
         metadata = COALESCE(metadata, '{}'::jsonb)
                    || jsonb_build_object('failure_reason', COALESCE(p_reason, 'offramp_failed'))
   WHERE type = 'crypto_sell'
     AND (metadata->>'quidax_reference' = p_reference OR metadata->>'quidax_merchant_reference' = p_reference)
     AND status = 'pending'
  RETURNING id INTO v_tx_id;

  IF v_tx_id IS NOT NULL THEN
    PERFORM public.record_monitoring_alert(
      p_fingerprint := ('crypto_sell_offramp_failed_' || v_tx_id::text),
      p_type := 'crypto_sell_offramp_failed',
      p_severity := 'critical',
      p_details := jsonb_build_object('transaction_id', v_tx_id, 'reference', p_reference, 'reason', p_reason)
    );
  END IF;

  RETURN v_tx_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.record_crypto_sell_offramp_pending(UUID, TEXT, BIGINT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_crypto_sell_offramp_pending(UUID, TEXT, BIGINT, TEXT, TEXT, TEXT, TEXT, TEXT) TO service_role;

REVOKE EXECUTE ON FUNCTION public.complete_crypto_sell_offramp(TEXT, BIGINT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_crypto_sell_offramp(TEXT, BIGINT) TO service_role;

REVOKE EXECUTE ON FUNCTION public.fail_crypto_sell_offramp(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fail_crypto_sell_offramp(TEXT, TEXT) TO service_role;
