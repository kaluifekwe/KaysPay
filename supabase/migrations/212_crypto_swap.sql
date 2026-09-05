-- Customer-facing Swap: converts one held coin directly into another,
-- across all 9 supported assets (USDT + the 8 SUPPORTED_SWAP_ASSETS), in
-- either direction. Reuses the exact same Quidax swap_quotation mechanism
-- Buy's leg 2 (USDT -> coin) and Sell's leg 1 (coin -> USDT) already prove
-- out live for every one of these coins -- this just exposes it directly to
-- the customer instead of only running it internally. Owner decision,
-- 2026-09-05, partly to give a customer who lands on substituted USDT (see
-- fail_crypto_buy_swap, migration 127) a self-service way to convert it into
-- the coin they actually wanted, without needing admin help.
--
-- Unlike Sell, there's no off-ramp leg -- the destination coin lands
-- straight back in the same Quidax sub-account, and the live wallet read
-- (getSubAccountWallets) picks it up automatically. So this is a single-leg
-- async settlement: request -> createSwapQuotation -> confirmSwapQuotation
-- -> wait for crypto-quidax-webhook's swap_transaction.complete/.failed.

-- Records the swap as pending the moment confirmSwapQuotation is called --
-- before Quidax has actually settled it. p_from_crypto_micro is in the
-- FROM coin's units; the actual amount received is only known once the
-- swap completes (see complete_crypto_swap below).
CREATE OR REPLACE FUNCTION public.record_crypto_swap_pending(
  p_user_id           UUID,
  p_from_asset        TEXT,
  p_to_asset          TEXT,
  p_from_crypto_micro BIGINT,
  p_swap_quotation_id TEXT,
  p_idempotency_key   TEXT
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tx_id UUID;
BEGIN
  IF p_from_crypto_micro IS NULL OR p_from_crypto_micro <= 0 OR p_swap_quotation_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_SWAP';
  END IF;

  SELECT id INTO v_tx_id FROM transactions
   WHERE metadata->>'idempotency_key' = p_idempotency_key LIMIT 1;
  IF v_tx_id IS NOT NULL THEN
    RETURN v_tx_id;
  END IF;

  INSERT INTO transactions (user_id, type, recipient_phone, network, amount_ngn, status, metadata)
  VALUES (p_user_id, 'crypto_swap', p_from_asset || '->' || p_to_asset, 'N/A', 0, 'pending',
          jsonb_build_object('from_asset', p_from_asset, 'to_asset', p_to_asset,
                              'from_crypto_micro', p_from_crypto_micro,
                              'swap_quotation_id', p_swap_quotation_id,
                              'idempotency_key', p_idempotency_key))
  RETURNING id INTO v_tx_id;

  RETURN v_tx_id;
END;
$$;

-- The swap settled (crypto-quidax-webhook's swap_transaction.complete).
-- Atomically claims the pending row so a retried/duplicate webhook delivery
-- for the same swap finds status already advanced and gets nothing back --
-- same not-mine-move-on contract complete_crypto_buy_swap and
-- claim_crypto_sell_swap_for_offramp already use. Returns what the
-- notification needs; the caller (webhook) never has the original request's
-- context by the time this fires.
CREATE OR REPLACE FUNCTION public.complete_crypto_swap(
  p_swap_quotation_id TEXT,
  p_to_crypto_micro   BIGINT
) RETURNS TABLE (
  transaction_id UUID,
  user_id UUID,
  from_asset TEXT,
  to_asset TEXT,
  from_crypto_micro BIGINT
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY
  UPDATE transactions t
     SET status = 'completed',
         metadata = t.metadata || jsonb_build_object('to_crypto_micro', p_to_crypto_micro)
   WHERE t.type = 'crypto_swap'
     AND t.status = 'pending'
     AND t.metadata->>'swap_quotation_id' = p_swap_quotation_id
  RETURNING t.id, t.user_id, t.metadata->>'from_asset', t.metadata->>'to_asset',
            (t.metadata->>'from_crypto_micro')::BIGINT;
END;
$$;

-- The swap failed -- either synchronously (confirmSwapQuotation itself
-- threw, called straight from crypto-swap/index.ts) or asynchronously
-- (crypto-quidax-webhook's swap_transaction.failed, for a swap that was
-- accepted but didn't settle). Either way nothing is lost: the FROM coin
-- never actually left the sub-account, unlike Sell's swap-then-offramp
-- where the swap itself is one of two irreversible legs. No monitoring
-- alert -- same "swap just didn't go through" case Buy and Sell's own
-- swap legs already handle without escalating.
CREATE OR REPLACE FUNCTION public.fail_crypto_swap(
  p_swap_quotation_id TEXT,
  p_reason TEXT DEFAULT NULL
) RETURNS TABLE (
  transaction_id UUID,
  user_id UUID,
  from_asset TEXT,
  to_asset TEXT
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY
  UPDATE transactions t
     SET status = 'failed',
         metadata = COALESCE(t.metadata, '{}'::jsonb)
                    || jsonb_build_object('failure_reason', COALESCE(p_reason, 'swap_failed'))
   WHERE t.type = 'crypto_swap'
     AND t.status = 'pending'
     AND t.metadata->>'swap_quotation_id' = p_swap_quotation_id
  RETURNING t.id, t.user_id, t.metadata->>'from_asset', t.metadata->>'to_asset';
END;
$$;

REVOKE EXECUTE ON FUNCTION public.record_crypto_swap_pending(UUID, TEXT, TEXT, BIGINT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_crypto_swap_pending(UUID, TEXT, TEXT, BIGINT, TEXT, TEXT) TO service_role;

REVOKE EXECUTE ON FUNCTION public.complete_crypto_swap(TEXT, BIGINT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_crypto_swap(TEXT, BIGINT) TO service_role;

REVOKE EXECUTE ON FUNCTION public.fail_crypto_swap(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fail_crypto_swap(TEXT, TEXT) TO service_role;
