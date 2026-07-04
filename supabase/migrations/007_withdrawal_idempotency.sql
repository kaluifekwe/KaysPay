-- Kay's Pay: Withdrawal idempotency
-- =====================================================================
-- Prevents a double-tapped / retried withdrawal from debiting the wallet
-- and initiating a Paystack transfer more than once. The client sends a
-- stable idempotency key per withdrawal intent; the first call creates the
-- withdrawal, any replay returns the existing one without re-debiting.
-- =====================================================================

ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_withdrawals_idempotency_key
  ON withdrawals (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Replace the previous signature (add p_idempotency_key).
DROP FUNCTION IF EXISTS public.debit_for_withdrawal(UUID, NUMERIC, TEXT, TEXT, TEXT, TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.debit_for_withdrawal(
  p_user_id         UUID,
  p_amount          NUMERIC,
  p_reference       TEXT,
  p_bank_name       TEXT,
  p_bank_code       TEXT,
  p_account_number  TEXT,
  p_account_name    TEXT,
  p_idempotency_key TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_balance       NUMERIC;
  v_withdrawal_id UUID;
  v_existing      withdrawals%ROWTYPE;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT';
  END IF;

  -- Replay? Return the existing withdrawal without re-debiting.
  IF p_idempotency_key IS NOT NULL THEN
    SELECT * INTO v_existing
      FROM withdrawals
     WHERE idempotency_key = p_idempotency_key AND user_id = p_user_id;

    IF v_existing.id IS NOT NULL THEN
      SELECT balance INTO v_balance FROM wallets WHERE user_id = p_user_id;
      RETURN jsonb_build_object(
        'replay', true,
        'withdrawal_id', v_existing.id,
        'status', v_existing.status,
        'reference', v_existing.paystack_reference,
        'balance', COALESCE(v_balance, 0)
      );
    END IF;
  END IF;

  -- First time: lock wallet, verify funds, debit, create records.
  SELECT balance INTO v_balance FROM wallets WHERE user_id = p_user_id FOR UPDATE;
  IF v_balance IS NULL THEN
    RAISE EXCEPTION 'WALLET_NOT_FOUND';
  END IF;
  IF v_balance < p_amount THEN
    RAISE EXCEPTION 'INSUFFICIENT_FUNDS';
  END IF;

  UPDATE wallets
     SET balance = balance - p_amount, updated_at = now()
   WHERE user_id = p_user_id;

  INSERT INTO withdrawals (user_id, amount_ngn, bank_name, bank_code,
                           account_number, account_name, status,
                           paystack_reference, idempotency_key)
  VALUES (p_user_id, p_amount, p_bank_name, p_bank_code,
          p_account_number, p_account_name, 'processing',
          p_reference, p_idempotency_key)
  RETURNING id INTO v_withdrawal_id;

  INSERT INTO transactions (user_id, type, amount_ngn, status, metadata)
  VALUES (p_user_id, 'withdrawal', p_amount, 'pending',
          jsonb_build_object('bank_name', p_bank_name, 'bank_code', p_bank_code,
                             'account_number', p_account_number, 'account_name', p_account_name,
                             'paystack_reference', p_reference));

  RETURN jsonb_build_object(
    'replay', false,
    'balance', v_balance - p_amount,
    'withdrawal_id', v_withdrawal_id,
    'reference', p_reference
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.debit_for_withdrawal(UUID, NUMERIC, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.debit_for_withdrawal(UUID, NUMERIC, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO service_role;
