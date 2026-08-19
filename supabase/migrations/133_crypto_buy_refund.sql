-- Automates the Quidax Ramp refund flow: when a buy's paying bank account
-- doesn't name-match the customer, Quidax auto-refunds and asks the merchant
-- (via buy_transaction.refund.details_requested) for a bank account to send
-- it back to. Buy never debits the KaysPay wallet, so there is nothing for
-- KaysPay itself to refund — this is purely "collect the customer's bank
-- details and forward them to Quidax", then mark the local order failed once
-- Quidax confirms the refund landed (buy_transaction.refund.completed, which
-- reuses the existing fail_crypto_buy from migration 120).

-- Flags a pending buy as needing the customer's bank details. Idempotent: a
-- re-delivered webhook (or a refund requested twice, which shouldn't happen
-- but Quidax's own retries are not something to trust blindly) is a no-op
-- once the flag is already set.
CREATE OR REPLACE FUNCTION public.mark_crypto_buy_refund_requested(
  p_merchant_reference TEXT
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tx_id UUID;
BEGIN
  SELECT id INTO v_tx_id FROM transactions
   WHERE metadata->>'quidax_merchant_reference' = p_merchant_reference
     AND type = 'crypto_buy'
     AND status = 'pending'
   FOR UPDATE;

  IF v_tx_id IS NULL THEN
    RETURN NULL;
  END IF;

  UPDATE transactions
     SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
           'needs_refund_bank_details', true,
           'refund_requested_at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
         )
   WHERE id = v_tx_id;

  RETURN v_tx_id;
END;
$$;

-- Records that the customer's bank details were submitted to Quidax and
-- clears the "needs details" flag so the app stops prompting. Status stays
-- 'pending' — the order only actually finishes when
-- buy_transaction.refund.completed arrives and calls fail_crypto_buy.
-- Requires the flag to already be set, so this can't be called out of order
-- against a buy that was never flagged for refund in the first place.
CREATE OR REPLACE FUNCTION public.record_crypto_buy_refund_submitted(
  p_merchant_reference TEXT,
  p_bank_code          TEXT,
  p_account_number     TEXT,
  p_account_name       TEXT
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tx_id UUID;
  v_needs_details BOOLEAN;
BEGIN
  SELECT id, (metadata->>'needs_refund_bank_details')::boolean
    INTO v_tx_id, v_needs_details
    FROM transactions
   WHERE metadata->>'quidax_merchant_reference' = p_merchant_reference
     AND type = 'crypto_buy'
     AND status = 'pending'
   FOR UPDATE;

  IF v_tx_id IS NULL OR v_needs_details IS NOT TRUE THEN
    RETURN NULL;
  END IF;

  UPDATE transactions
     SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
           'needs_refund_bank_details', false,
           'refund_bank_code', p_bank_code,
           'refund_account_number', p_account_number,
           'refund_account_name', p_account_name,
           'refund_submitted_at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
         )
   WHERE id = v_tx_id;

  RETURN v_tx_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.mark_crypto_buy_refund_requested(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.record_crypto_buy_refund_submitted(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.mark_crypto_buy_refund_requested(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_crypto_buy_refund_submitted(TEXT, TEXT, TEXT, TEXT) TO service_role;
