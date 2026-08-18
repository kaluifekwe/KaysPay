-- Fix debit_for_transfer: the `network` column carries a CHECK constraint
-- scoped to telecom networks only ('mtn','airtel','glo','9mobile','N/A' —
-- see migration 015), left over from VTU. Transfer isn't a VTU purchase and
-- has nothing telecom-related to put there — migration 128 mistakenly
-- inserted the recipient's BANK NAME into this column, which the
-- constraint correctly rejected the first time a real transfer ran (same
-- class of bug as 015 itself: "never caught because no purchase had gone
-- through this code path... until now"). The bank name already lives in
-- metadata (recipient_bank_name) — this just stops trying to also cram it
-- into a column it was never meant for.
CREATE OR REPLACE FUNCTION public.debit_for_transfer(
  p_user_id                 UUID,
  p_amount                  BIGINT,  -- kobo
  p_recipient_name          TEXT,
  p_recipient_account_number TEXT,
  p_recipient_bank_code     TEXT,
  p_recipient_bank_name     TEXT,
  p_provider                TEXT,    -- 'flutterwave' | 'paystack'
  p_idempotency_key         TEXT
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_balance      BIGINT;
  v_tx_id        UUID;
  v_today_total  BIGINT;
  v_min_kobo     CONSTANT BIGINT := 10000;        -- ₦100
  v_max_kobo     CONSTANT BIGINT := 50000000;      -- ₦500,000 per transfer
  v_daily_cap    CONSTANT BIGINT := 100000000;     -- ₦1,000,000 per rolling day
BEGIN
  IF p_amount IS NULL OR p_amount < v_min_kobo OR p_amount > v_max_kobo THEN
    RAISE EXCEPTION 'INVALID_AMOUNT';
  END IF;
  IF p_provider NOT IN ('flutterwave', 'paystack') THEN
    RAISE EXCEPTION 'INVALID_PROVIDER';
  END IF;

  SELECT id INTO v_tx_id
    FROM transactions
   WHERE metadata->>'idempotency_key' = p_idempotency_key
   LIMIT 1;
  IF v_tx_id IS NOT NULL THEN
    RETURN v_tx_id;
  END IF;

  SELECT balance INTO v_balance
    FROM wallets WHERE user_id = p_user_id FOR UPDATE;
  IF v_balance IS NULL THEN
    RAISE EXCEPTION 'WALLET_NOT_FOUND';
  END IF;
  IF v_balance < p_amount THEN
    RAISE EXCEPTION 'INSUFFICIENT_FUNDS';
  END IF;

  SELECT COALESCE(SUM(amount_ngn), 0) INTO v_today_total
    FROM transactions
   WHERE user_id = p_user_id
     AND type = 'transfer'
     AND status IN ('pending', 'completed')
     AND created_at >= date_trunc('day', now());
  IF v_today_total + p_amount > v_daily_cap THEN
    RAISE EXCEPTION 'DAILY_LIMIT_EXCEEDED';
  END IF;

  UPDATE wallets SET
    balance = balance - p_amount,
    updated_at = now()
  WHERE user_id = p_user_id;

  INSERT INTO transactions (user_id, type, recipient_phone, network, amount_ngn, status, metadata)
  VALUES (
    p_user_id, 'transfer', p_recipient_account_number, 'N/A', p_amount, 'pending',
    jsonb_build_object(
      'idempotency_key', p_idempotency_key,
      'provider', p_provider,
      'recipient_name', p_recipient_name,
      'recipient_account_number', p_recipient_account_number,
      'recipient_bank_code', p_recipient_bank_code,
      'recipient_bank_name', p_recipient_bank_name
    )
  )
  RETURNING id INTO v_tx_id;

  RETURN v_tx_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.debit_for_transfer(UUID, BIGINT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.debit_for_transfer(UUID, BIGINT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO service_role;
