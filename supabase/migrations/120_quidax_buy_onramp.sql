-- Phase 3: Buy becomes a real purchase. The customer transfers Naira to a
-- one-time bank account Quidax generates, and Quidax delivers USDT into the
-- customer's own sub-account — the same balance Sell and Withdraw already
-- spend from. KaysPay never fronts liquidity and never touches the Naira,
-- so there is deliberately no wallet debit or crypto ledger credit here:
-- these functions only track the order's lifecycle for History and support.
--
-- The legacy internal-ledger buy (buy_crypto / crypto_balances, migration
-- 082) is left in place but is no longer called by crypto-buy; retiring it
-- is Phase 4, once no user still holds a legacy balance.

-- Looking an order up by the reference we generated is the hot path for
-- every webhook delivery, so index it rather than scanning metadata.
CREATE INDEX IF NOT EXISTS idx_transactions_quidax_merchant_reference
  ON public.transactions ((metadata->>'quidax_merchant_reference'))
  WHERE metadata->>'quidax_merchant_reference' IS NOT NULL;

/**
 * Records a purchase awaiting the customer's bank transfer. Idempotent on
 * the merchant reference so a retried request reuses the same order (and
 * therefore the same bank account) instead of opening a second one.
 */
CREATE OR REPLACE FUNCTION public.start_crypto_buy(
  p_user_id             UUID,
  p_merchant_reference  TEXT,
  p_ngn_kobo            BIGINT,
  p_estimated_micro     BIGINT,
  p_rate                NUMERIC,
  p_metadata            JSONB DEFAULT '{}'::jsonb
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tx_id UUID;
BEGIN
  IF p_merchant_reference IS NULL OR length(p_merchant_reference) = 0
     OR p_ngn_kobo IS NULL OR p_ngn_kobo <= 0 THEN
    RAISE EXCEPTION 'INVALID_BUY_ORDER';
  END IF;

  SELECT id INTO v_tx_id FROM transactions
   WHERE metadata->>'quidax_merchant_reference' = p_merchant_reference LIMIT 1;
  IF v_tx_id IS NOT NULL THEN
    RETURN v_tx_id;
  END IF;

  INSERT INTO transactions (user_id, type, recipient_phone, network, amount_ngn, status, metadata)
  VALUES (p_user_id, 'crypto_buy', 'USDT', 'N/A', p_ngn_kobo, 'pending',
          COALESCE(p_metadata, '{}'::jsonb) || jsonb_build_object(
            'asset', 'USDT',
            'quidax_merchant_reference', p_merchant_reference,
            'estimated_crypto_micro', p_estimated_micro,
            'rate', p_rate,
            'funding', 'bank_transfer'
          ))
  RETURNING id INTO v_tx_id;

  RETURN v_tx_id;
END;
$$;

/**
 * Settles a purchase once Quidax confirms the Naira arrived and the USDT was
 * delivered. Records what was ACTUALLY received rather than the estimate, and
 * credits nothing locally — the coin is real and sits in the customer's own
 * sub-account, where the balance is read live from Quidax. Returns NULL if
 * the order is unknown or already settled, so a redelivered webhook is a
 * no-op rather than a double-count.
 */
CREATE OR REPLACE FUNCTION public.complete_crypto_buy(
  p_merchant_reference TEXT,
  p_crypto_micro       BIGINT,
  p_tx_hash            TEXT DEFAULT NULL
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
     SET status = 'completed',
         completed_at = now(),
         metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
           'crypto_micro', p_crypto_micro,
           'txid', p_tx_hash
         )
   WHERE id = v_tx_id;

  RETURN v_tx_id;
END;
$$;

/** Marks a purchase failed (Quidax rejected it, or the Naira never arrived).
 * Nothing to refund — the customer's money never left their own bank. */
CREATE OR REPLACE FUNCTION public.fail_crypto_buy(
  p_merchant_reference TEXT,
  p_reason             TEXT DEFAULT NULL
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
     SET status = 'failed',
         metadata = COALESCE(metadata, '{}'::jsonb)
                    || jsonb_build_object('failure_reason', COALESCE(p_reason, 'rejected'))
   WHERE id = v_tx_id;

  RETURN v_tx_id;
END;
$$;

-- Every one of these is service-role only. Spelling out anon/authenticated
-- as well as PUBLIC is deliberate: Supabase grants EXECUTE to those roles by
-- default on creation, and revoking PUBLIC alone does NOT remove them —
-- exactly the gap the privilege monitor caught in migration 117.
REVOKE EXECUTE ON FUNCTION public.start_crypto_buy(UUID, TEXT, BIGINT, BIGINT, NUMERIC, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.complete_crypto_buy(TEXT, BIGINT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fail_crypto_buy(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.start_crypto_buy(UUID, TEXT, BIGINT, BIGINT, NUMERIC, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_crypto_buy(TEXT, BIGINT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_crypto_buy(TEXT, TEXT) TO service_role;
