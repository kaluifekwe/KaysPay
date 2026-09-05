-- Safety net for the OTHER "swap never happened" case in a Buy's leg 2:
-- fail_crypto_buy_swap (migration 127) only fires once a swap quotation
-- actually exists (matched by quidax_swap_id), which never gets created
-- if createSwapQuotation itself throws -- an order stuck this way had NO
-- notification at all and no way to ever resolve, since nothing matched
-- it by swap id. Matched by merchant_reference instead, since that's the
-- only handle settleCryptoBuySuccess has at this point. Same final shape
-- as fail_crypto_buy_swap (swap_failed/settled_as/crypto_micro/
-- failure_reason) so anything reading that metadata treats both fallback
-- paths identically.
CREATE OR REPLACE FUNCTION public.fail_crypto_buy_swap_start(
  p_merchant_reference TEXT,
  p_usdt_micro         BIGINT,
  p_reason             TEXT DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tx_id UUID;
BEGIN
  SELECT id INTO v_tx_id
    FROM transactions
   WHERE type = 'crypto_buy' AND metadata->>'quidax_merchant_reference' = p_merchant_reference AND status = 'pending'
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
           'crypto_micro', p_usdt_micro,
           'failure_reason', COALESCE(p_reason, 'swap_start_failed')
         )
   WHERE id = v_tx_id;

  RETURN v_tx_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fail_crypto_buy_swap_start(TEXT, BIGINT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fail_crypto_buy_swap_start(TEXT, BIGINT, TEXT) TO service_role;
