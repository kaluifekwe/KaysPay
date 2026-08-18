-- Multi-asset Buy: beyond USDT, a purchase is now two async legs —
-- (1) Ramp delivers USDT into the customer's own Quidax sub-account (same
-- as today), then (2) that USDT is swapped for the target coin inside the
-- same sub-account (crypto-quidax-webhook, using the swap_quotation flow
-- crypto-sell already uses in the other direction). Both legs move only the
-- customer's own funds inside their own sub-account — KaysPay never fronts
-- liquidity, same principle as every crypto function before this one.
--
-- Deliberately reuses the existing 'pending' / 'completed' / 'failed'
-- status enum rather than adding new values — leg 1 settling is an interim
-- state tracked in metadata (usdt_settled_micro, quidax_swap_id), not a new
-- top-level status, so the transactions.status CHECK constraint (migration
-- 001) doesn't need touching. If leg 2 fails, the row still settles
-- 'completed' (real value was delivered — USDT, sitting safely in the
-- customer's own account) rather than 'failed', with metadata flagging the
-- fallback so History/support can tell the two apart.

-- start_crypto_buy gains p_asset — no longer hardcoded to 'USDT'. The old
-- 5-arg signature is dropped rather than left as a dead overload.
DROP FUNCTION IF EXISTS public.start_crypto_buy(UUID, TEXT, BIGINT, BIGINT, NUMERIC, JSONB);

CREATE OR REPLACE FUNCTION public.start_crypto_buy(
  p_user_id             UUID,
  p_merchant_reference  TEXT,
  p_ngn_kobo            BIGINT,
  p_estimated_micro     BIGINT,
  p_rate                NUMERIC,
  p_asset               TEXT,
  p_metadata            JSONB DEFAULT '{}'::jsonb
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tx_id UUID;
BEGIN
  IF p_merchant_reference IS NULL OR length(p_merchant_reference) = 0
     OR p_ngn_kobo IS NULL OR p_ngn_kobo <= 0
     OR p_asset IS NULL OR length(p_asset) = 0 THEN
    RAISE EXCEPTION 'INVALID_BUY_ORDER';
  END IF;

  SELECT id INTO v_tx_id FROM transactions
   WHERE metadata->>'quidax_merchant_reference' = p_merchant_reference LIMIT 1;
  IF v_tx_id IS NOT NULL THEN
    RETURN v_tx_id;
  END IF;

  INSERT INTO transactions (user_id, type, recipient_phone, network, amount_ngn, status, metadata)
  VALUES (p_user_id, 'crypto_buy', p_asset, 'N/A', p_ngn_kobo, 'pending',
          COALESCE(p_metadata, '{}'::jsonb) || jsonb_build_object(
            'asset', p_asset,
            'quidax_merchant_reference', p_merchant_reference,
            'estimated_crypto_micro', p_estimated_micro,
            'rate', p_rate,
            'funding', 'bank_transfer'
          ))
  RETURNING id INTO v_tx_id;

  RETURN v_tx_id;
END;
$$;

-- Leg 1 settled but the target asset isn't USDT, so this ISN'T the finish —
-- records what actually arrived and the swap quotation now in flight, and
-- deliberately leaves status as 'pending'. Idempotent on merchant reference;
-- a re-delivered buy_transaction.successful webhook after the swap has
-- already been kicked off is a no-op (usdt_settled_micro already set).
CREATE OR REPLACE FUNCTION public.record_crypto_buy_swap_pending(
  p_merchant_reference TEXT,
  p_usdt_micro         BIGINT,
  p_swap_id            TEXT
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tx_id  UUID;
  v_status TEXT;
BEGIN
  SELECT id, status INTO v_tx_id, v_status FROM transactions
   WHERE type = 'crypto_buy' AND metadata->>'quidax_merchant_reference' = p_merchant_reference
   FOR UPDATE;

  IF v_tx_id IS NULL THEN
    RETURN NULL;
  END IF;
  IF v_status <> 'pending' THEN
    RETURN v_tx_id;
  END IF;
  -- Already recorded by an earlier delivery of the same webhook — don't
  -- overwrite with a second (possibly different) swap quotation.
  IF (SELECT metadata->>'quidax_swap_id' FROM transactions WHERE id = v_tx_id) IS NOT NULL THEN
    RETURN v_tx_id;
  END IF;

  UPDATE transactions
     SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
           'usdt_settled_micro', p_usdt_micro,
           'quidax_swap_id', p_swap_id
         )
   WHERE id = v_tx_id;

  RETURN v_tx_id;
END;
$$;

-- Leg 2 settled: Quidax confirmed the swap. Records what was ACTUALLY
-- received (never the earlier estimate) and marks the order completed.
-- Returns NULL if no pending crypto_buy row matches this swap id, so the
-- webhook caller knows to fall through and check whether it's a Sell swap
-- instead (crypto_sell uses the same swap_transaction.complete event).
CREATE OR REPLACE FUNCTION public.complete_crypto_buy_swap(
  p_swap_id      TEXT,
  p_crypto_micro BIGINT
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tx_id UUID;
BEGIN
  SELECT id INTO v_tx_id FROM transactions
   WHERE type = 'crypto_buy' AND metadata->>'quidax_swap_id' = p_swap_id AND status = 'pending'
   FOR UPDATE;

  IF v_tx_id IS NULL THEN
    RETURN NULL;
  END IF;

  UPDATE transactions
     SET status = 'completed',
         completed_at = now(),
         metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('crypto_micro', p_crypto_micro)
   WHERE id = v_tx_id;

  RETURN v_tx_id;
END;
$$;

-- Leg 2 failed after leg 1 already delivered real USDT into the customer's
-- own sub-account — nothing was lost, so this settles 'completed' rather
-- than 'failed', reporting the USDT they actually hold instead of the coin
-- they asked for. Same NULL-means-not-mine contract as complete_crypto_buy_swap.
CREATE OR REPLACE FUNCTION public.fail_crypto_buy_swap(
  p_swap_id TEXT,
  p_reason  TEXT DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tx_id            UUID;
  v_usdt_settled     BIGINT;
BEGIN
  SELECT id, (metadata->>'usdt_settled_micro')::BIGINT INTO v_tx_id, v_usdt_settled
    FROM transactions
   WHERE type = 'crypto_buy' AND metadata->>'quidax_swap_id' = p_swap_id AND status = 'pending'
   FOR UPDATE;

  IF v_tx_id IS NULL THEN
    RETURN NULL;
  END IF;

  UPDATE transactions
     SET status = 'completed',
         completed_at = now(),
         metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
           'swap_failed', true,
           'settled_as', 'USDT',
           'crypto_micro', v_usdt_settled,
           'failure_reason', COALESCE(p_reason, 'swap_failed')
         )
   WHERE id = v_tx_id;

  RETURN v_tx_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.start_crypto_buy(UUID, TEXT, BIGINT, BIGINT, NUMERIC, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.record_crypto_buy_swap_pending(TEXT, BIGINT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.complete_crypto_buy_swap(TEXT, BIGINT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fail_crypto_buy_swap(TEXT, TEXT) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.start_crypto_buy(UUID, TEXT, BIGINT, BIGINT, NUMERIC, TEXT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_crypto_buy_swap_pending(TEXT, BIGINT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_crypto_buy_swap(TEXT, BIGINT) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_crypto_buy_swap(TEXT, TEXT) TO service_role;
