-- Records the moment Quidax confirms a Buy's fiat deposit landed
-- (buy_transaction.processing), separate from created_at (when the customer
-- tapped Buy — includes however long they personally took to send the
-- transfer) and completed_at (when the payout finished). With this,
-- completed_at - fiat_received_at is Quidax's own payout time, isolated
-- from the customer's own transfer time — the split the owner asked for
-- after their first successful buy (3m05s total, but no way to say how much
-- of that was theirs vs Quidax's).
--
-- Idempotent: a re-delivered "processing" webhook (or one that arrives after
-- "successful" due to out-of-order delivery) never overwrites an
-- already-recorded timestamp.
CREATE OR REPLACE FUNCTION public.mark_crypto_buy_fiat_received(
  p_merchant_reference TEXT
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tx_id UUID;
BEGIN
  SELECT id INTO v_tx_id FROM transactions
   WHERE metadata->>'quidax_merchant_reference' = p_merchant_reference
     AND type = 'crypto_buy'
   FOR UPDATE;

  IF v_tx_id IS NULL THEN
    RETURN NULL;
  END IF;

  UPDATE transactions
     SET metadata = metadata || jsonb_build_object(
           'fiat_received_at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
         )
   WHERE id = v_tx_id
     AND metadata->>'fiat_received_at' IS NULL;

  RETURN v_tx_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.mark_crypto_buy_fiat_received(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_crypto_buy_fiat_received(TEXT) TO service_role;
