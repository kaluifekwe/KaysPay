-- Extends Sell beyond USDT to BTC/ETH/SOL/XRP/TRX/LTC/DOGE/ADA. These coins
-- have no off-ramp of their own (crypto-sell/index.ts's off-ramp only ever
-- proved out for USDT) — instead, the source coin is swapped to USDT INSIDE
-- the customer's own Quidax sub-account first (internal ledger conversion,
-- no on-chain movement, no destination-tag risk even for XRP), then the
-- existing, already-proven USDT off-ramp runs completely unchanged on the
-- resulting USDT. Verified live against Quidax 2026-09-05: all 8 coins
-- quote a real coin->USDT swap.
--
-- This is a genuine two-stage async settlement: the swap itself completes
-- later via crypto-quidax-webhook's swap_transaction.complete handler, not
-- inside the original request (same shape Buy's own USDT->coin swap leg
-- already uses). The functions below let that webhook pick up where the
-- request left off WITHOUT crypto-ramp-webhook (off-ramp completion) ever
-- needing to know or care whether a sale started as USDT-direct or
-- coin-via-swap: once the swap leg finishes, this writes the exact same
-- quidax_reference/quidax_merchant_reference metadata fields
-- complete_crypto_sell_offramp/fail_crypto_sell_offramp (migration 139)
-- already match on, so that pair needs zero changes.

-- Step 1: record the sale as pending the MOMENT the swap is confirmed —
-- before the coin has actually converted, let alone left the sub-account.
-- p_source_crypto_micro is in the ORIGINAL coin's units (what the customer
-- typed and sees in history); the USDT amount is only known once the swap
-- itself completes (see claim_crypto_sell_swap_for_offramp below).
CREATE OR REPLACE FUNCTION public.record_crypto_sell_swap_pending(
  p_user_id             UUID,
  p_source_asset        TEXT,
  p_source_crypto_micro BIGINT,
  p_swap_quotation_id   TEXT,
  p_recipient_bank_name TEXT,
  p_recipient_account_number TEXT,
  p_bank_code           TEXT,
  p_idempotency_key     TEXT
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tx_id UUID;
BEGIN
  IF p_source_crypto_micro IS NULL OR p_source_crypto_micro <= 0 OR p_swap_quotation_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_SELL';
  END IF;

  SELECT id INTO v_tx_id FROM transactions
   WHERE metadata->>'idempotency_key' = p_idempotency_key LIMIT 1;
  IF v_tx_id IS NOT NULL THEN
    RETURN v_tx_id;
  END IF;

  INSERT INTO transactions (user_id, type, recipient_phone, network, amount_ngn, status, metadata)
  VALUES (p_user_id, 'crypto_sell', p_source_asset, 'N/A', 0, 'pending',
          jsonb_build_object('asset', p_source_asset, 'crypto_micro', p_source_crypto_micro,
                              'swap_quotation_id', p_swap_quotation_id,
                              'recipient_bank_name', p_recipient_bank_name,
                              'recipient_account_number', p_recipient_account_number,
                              'bank_code', p_bank_code,
                              'settlement', 'sell_via_swap',
                              'phase', 'awaiting_swap',
                              'idempotency_key', p_idempotency_key))
  RETURNING id INTO v_tx_id;

  RETURN v_tx_id;
END;
$$;

-- Step 2: the coin -> USDT swap completed (crypto-quidax-webhook's
-- swap_transaction.complete). Atomically claims this pending sale for
-- off-ramp initiation, advancing phase so a retried/duplicate webhook call
-- for the same swap finds phase already moved on and gets nothing back —
-- same not-mine-move-on contract complete_crypto_buy_swap already uses.
-- Returns the bank details needed to actually call the off-ramp (the
-- original request that recorded them is long gone by the time this
-- webhook fires).
CREATE OR REPLACE FUNCTION public.claim_crypto_sell_swap_for_offramp(
  p_swap_quotation_id TEXT,
  p_usdt_crypto_micro BIGINT
) RETURNS TABLE (
  transaction_id UUID,
  user_id UUID,
  recipient_bank_name TEXT,
  recipient_account_number TEXT,
  bank_code TEXT
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY
  UPDATE transactions t
     SET metadata = t.metadata || jsonb_build_object(
           'usdt_crypto_micro', p_usdt_crypto_micro,
           'phase', 'offramp_initiating'
         )
   WHERE t.type = 'crypto_sell'
     AND t.status = 'pending'
     AND t.metadata->>'swap_quotation_id' = p_swap_quotation_id
     AND t.metadata->>'phase' = 'awaiting_swap'
  RETURNING t.id, t.user_id, t.metadata->>'recipient_bank_name', t.metadata->>'recipient_account_number',
            t.metadata->>'bank_code';
END;
$$;

-- Step 3a: off-ramp initiation (initiateOffRamp/attachOffRampBankAccount/
-- confirmOffRamp) succeeded on the now-available USDT. Writes the exact
-- metadata fields complete_crypto_sell_offramp/fail_crypto_sell_offramp
-- (migration 139) already match on — from here, this transaction is
-- indistinguishable from a direct USDT sell to crypto-ramp-webhook.
CREATE OR REPLACE FUNCTION public.finalize_crypto_sell_swap_offramp_init(
  p_transaction_id UUID,
  p_reference TEXT,
  p_merchant_reference TEXT
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE transactions
     SET metadata = metadata || jsonb_build_object(
           'quidax_reference', p_reference,
           'quidax_merchant_reference', p_merchant_reference,
           'phase', 'awaiting_offramp_completion'
         )
   WHERE id = p_transaction_id AND status = 'pending';

  RETURN p_transaction_id;
END;
$$;

-- Step 3b: the swap itself completed but off-ramp initiation then failed
-- (attach-bank-account rejected, confirm failed, etc). Unlike
-- fail_crypto_sell_offramp, nothing has left the sub-account on-chain yet
-- at this point -- the coin already irreversibly became USDT (that part is
-- done), but that USDT is just sitting in the customer's own sub-account,
-- not sent anywhere. Recoverable, not "critical" -- still flagged for
-- follow-up since the customer is now holding USDT instead of the sale
-- proceeds they expected, and needs manual help finishing it.
CREATE OR REPLACE FUNCTION public.fail_crypto_sell_swap_leg(
  p_transaction_id UUID,
  p_reason TEXT DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE transactions
     SET status = 'failed',
         metadata = COALESCE(metadata, '{}'::jsonb)
                    || jsonb_build_object('failure_reason', COALESCE(p_reason, 'offramp_init_failed'))
   WHERE id = p_transaction_id AND status = 'pending';

  PERFORM public.record_monitoring_alert(
    p_fingerprint := ('crypto_sell_swap_offramp_init_failed_' || p_transaction_id::text),
    p_type := 'crypto_sell_swap_offramp_init_failed',
    p_severity := 'warning',
    p_details := jsonb_build_object('transaction_id', p_transaction_id, 'reason', p_reason)
  );

  RETURN p_transaction_id;
END;
$$;

-- If the swap itself fails (crypto-quidax-webhook's swap_transaction.failed)
-- before ever reaching the off-ramp, nothing irreversible happened at all --
-- the source coin never left the customer's balance. Still recorded failed
-- so the pending record doesn't linger forever, but no alert: this is the
-- same "swap just didn't go through" case Buy's own leg already handles
-- without escalating.
CREATE OR REPLACE FUNCTION public.fail_crypto_sell_swap_pending(
  p_swap_quotation_id TEXT,
  p_reason TEXT DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tx_id UUID;
BEGIN
  UPDATE transactions
     SET status = 'failed',
         metadata = COALESCE(metadata, '{}'::jsonb)
                    || jsonb_build_object('failure_reason', COALESCE(p_reason, 'swap_failed'))
   WHERE type = 'crypto_sell'
     AND status = 'pending'
     AND metadata->>'swap_quotation_id' = p_swap_quotation_id
     AND metadata->>'phase' = 'awaiting_swap'
  RETURNING id INTO v_tx_id;

  RETURN v_tx_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.record_crypto_sell_swap_pending(UUID, TEXT, BIGINT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_crypto_sell_swap_pending(UUID, TEXT, BIGINT, TEXT, TEXT, TEXT, TEXT, TEXT) TO service_role;

REVOKE EXECUTE ON FUNCTION public.claim_crypto_sell_swap_for_offramp(TEXT, BIGINT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_crypto_sell_swap_for_offramp(TEXT, BIGINT) TO service_role;

REVOKE EXECUTE ON FUNCTION public.finalize_crypto_sell_swap_offramp_init(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_crypto_sell_swap_offramp_init(UUID, TEXT, TEXT) TO service_role;

REVOKE EXECUTE ON FUNCTION public.fail_crypto_sell_swap_leg(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fail_crypto_sell_swap_leg(UUID, TEXT) TO service_role;

REVOKE EXECUTE ON FUNCTION public.fail_crypto_sell_swap_pending(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fail_crypto_sell_swap_pending(TEXT, TEXT) TO service_role;
