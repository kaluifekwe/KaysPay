-- Kay's Pay: Integer-kobo money (server-side source of truth)
-- =====================================================================
-- Converts all NGN money columns from NUMERIC(naira) to BIGINT(kobo) and
-- rewrites the money RPCs to operate on integer kobo. 1 naira = 100 kobo.
-- Existing values are whole naira, so multiplying by 100 is exact.
--
-- The client continues to work in naira; conversion happens once in the
-- client service layer (wallet/paystack/vtu services) and where Edge
-- Functions talk to providers (vtu.ng expects naira; Paystack expects kobo).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Column type changes (naira NUMERIC -> kobo BIGINT)
-- ---------------------------------------------------------------------

-- available_balance is GENERATED from balance/locked_amount, so it must be
-- dropped before retyping its inputs, then recreated.
ALTER TABLE wallets DROP COLUMN IF EXISTS available_balance;

ALTER TABLE wallets
  ALTER COLUMN balance TYPE BIGINT USING ROUND(balance * 100)::BIGINT,
  ALTER COLUMN balance SET DEFAULT 0,
  ALTER COLUMN locked_amount TYPE BIGINT USING ROUND(locked_amount * 100)::BIGINT,
  ALTER COLUMN locked_amount SET DEFAULT 0;

ALTER TABLE wallets
  ADD COLUMN available_balance BIGINT GENERATED ALWAYS AS (balance - locked_amount) STORED;

ALTER TABLE transactions
  ALTER COLUMN amount_ngn TYPE BIGINT USING ROUND(amount_ngn * 100)::BIGINT;

ALTER TABLE withdrawals
  ALTER COLUMN amount_ngn TYPE BIGINT USING ROUND(amount_ngn * 100)::BIGINT;

ALTER TABLE processed_payments
  ALTER COLUMN amount_ngn TYPE BIGINT USING ROUND(amount_ngn * 100)::BIGINT;

-- ---------------------------------------------------------------------
-- 2. Rewrite money RPCs to operate in kobo (BIGINT)
--    Signatures whose money param changes type are dropped + recreated;
--    grants are re-applied for those.
-- ---------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.credit_wallet_funding(UUID, TEXT, NUMERIC);
CREATE OR REPLACE FUNCTION public.credit_wallet_funding(
  p_user_id   UUID,
  p_reference TEXT,
  p_amount    BIGINT      -- kobo
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_balance  BIGINT;
  v_inserted BOOLEAN := FALSE;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT';
  END IF;

  INSERT INTO processed_payments (reference, user_id, amount_ngn)
  VALUES (p_reference, p_user_id, p_amount)
  ON CONFLICT (reference) DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  IF v_inserted = 0 THEN
    SELECT balance INTO v_balance FROM wallets WHERE user_id = p_user_id;
    RETURN jsonb_build_object('credited', false, 'balance', COALESCE(v_balance, 0), 'amount', p_amount);
  END IF;

  SELECT balance INTO v_balance FROM wallets WHERE user_id = p_user_id FOR UPDATE;
  IF v_balance IS NULL THEN
    RAISE EXCEPTION 'WALLET_NOT_FOUND';
  END IF;

  UPDATE wallets SET balance = balance + p_amount, updated_at = now() WHERE user_id = p_user_id;

  INSERT INTO transactions (user_id, type, amount_ngn, status, metadata, completed_at)
  VALUES (p_user_id, 'wallet_fund', p_amount, 'completed',
          jsonb_build_object('source', 'paystack', 'reference', p_reference), now());

  RETURN jsonb_build_object('credited', true, 'balance', v_balance + p_amount, 'amount', p_amount);
END;
$$;

DROP FUNCTION IF EXISTS public.debit_for_service(UUID, NUMERIC, TEXT, TEXT, TEXT, JSONB, TEXT);
CREATE OR REPLACE FUNCTION public.debit_for_service(
  p_user_id          UUID,
  p_amount           BIGINT,     -- kobo
  p_type             TEXT,
  p_network          TEXT,
  p_recipient        TEXT,
  p_metadata         JSONB,
  p_idempotency_key  TEXT
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_balance BIGINT;
  v_tx_id   UUID;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT';
  END IF;

  SELECT id INTO v_tx_id
    FROM transactions
   WHERE metadata->>'idempotency_key' = p_idempotency_key
   LIMIT 1;
  IF v_tx_id IS NOT NULL THEN
    RETURN v_tx_id;
  END IF;

  SELECT balance INTO v_balance FROM wallets WHERE user_id = p_user_id FOR UPDATE;
  IF v_balance IS NULL THEN
    RAISE EXCEPTION 'WALLET_NOT_FOUND';
  END IF;
  IF v_balance < p_amount THEN
    RAISE EXCEPTION 'INSUFFICIENT_FUNDS';
  END IF;

  UPDATE wallets SET balance = balance - p_amount, updated_at = now() WHERE user_id = p_user_id;

  INSERT INTO transactions (user_id, type, recipient_phone, network, amount_ngn, status, metadata)
  VALUES (p_user_id, p_type, p_recipient, COALESCE(p_network, 'N/A'), p_amount, 'pending',
          COALESCE(p_metadata, '{}'::jsonb) || jsonb_build_object('idempotency_key', p_idempotency_key))
  RETURNING id INTO v_tx_id;

  RETURN v_tx_id;
END;
$$;

-- Same signature: CREATE OR REPLACE keeps grants. Only the local var type changes.
CREATE OR REPLACE FUNCTION public.refund_service_transaction(
  p_tx_id UUID,
  p_reason TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID;
  v_amount  BIGINT;
BEGIN
  SELECT user_id, amount_ngn INTO v_user_id, v_amount
    FROM transactions
   WHERE id = p_tx_id AND status = 'pending'
   FOR UPDATE;

  IF v_user_id IS NULL THEN
    RETURN;
  END IF;

  UPDATE wallets SET balance = balance + v_amount, updated_at = now() WHERE user_id = v_user_id;

  UPDATE transactions
     SET status = 'failed',
         metadata = COALESCE(metadata, '{}'::jsonb)
                    || jsonb_build_object('failure_reason', COALESCE(p_reason, 'provider_error'),
                                          'refunded', true)
   WHERE id = p_tx_id;
END;
$$;

DROP FUNCTION IF EXISTS public.debit_for_withdrawal(UUID, NUMERIC, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT);
CREATE OR REPLACE FUNCTION public.debit_for_withdrawal(
  p_user_id         UUID,
  p_amount          BIGINT,     -- kobo
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
  v_balance       BIGINT;
  v_withdrawal_id UUID;
  v_existing      withdrawals%ROWTYPE;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT';
  END IF;

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

  SELECT balance INTO v_balance FROM wallets WHERE user_id = p_user_id FOR UPDATE;
  IF v_balance IS NULL THEN
    RAISE EXCEPTION 'WALLET_NOT_FOUND';
  END IF;
  IF v_balance < p_amount THEN
    RAISE EXCEPTION 'INSUFFICIENT_FUNDS';
  END IF;

  UPDATE wallets SET balance = balance - p_amount, updated_at = now() WHERE user_id = p_user_id;

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

-- Same signature: CREATE OR REPLACE keeps grants. Only the local var type changes.
CREATE OR REPLACE FUNCTION public.refund_withdrawal_by_reference(
  p_reference TEXT,
  p_reason    TEXT DEFAULT 'withdrawal_failed'
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID;
  v_amount  BIGINT;
BEGIN
  SELECT user_id, amount_ngn INTO v_user_id, v_amount
    FROM withdrawals
   WHERE paystack_reference = p_reference
     AND status NOT IN ('failed')
   FOR UPDATE;

  IF v_user_id IS NULL THEN
    RETURN;
  END IF;

  UPDATE wallets SET balance = balance + v_amount, updated_at = now() WHERE user_id = v_user_id;

  UPDATE withdrawals SET status = 'failed', failure_reason = p_reason
   WHERE paystack_reference = p_reference;

  INSERT INTO transactions (user_id, type, amount_ngn, status, metadata, completed_at)
  VALUES (v_user_id, 'refund', v_amount, 'completed',
          jsonb_build_object('reason', p_reason, 'reference', p_reference), now());
END;
$$;

-- ---------------------------------------------------------------------
-- 3. Re-apply grants for the dropped+recreated functions
-- ---------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.credit_wallet_funding(UUID, TEXT, BIGINT)                       FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.debit_for_service(UUID, BIGINT, TEXT, TEXT, TEXT, JSONB, TEXT)  FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.debit_for_withdrawal(UUID, BIGINT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.credit_wallet_funding(UUID, TEXT, BIGINT)                        TO service_role;
GRANT EXECUTE ON FUNCTION public.debit_for_service(UUID, BIGINT, TEXT, TEXT, TEXT, JSONB, TEXT)   TO service_role;
GRANT EXECUTE ON FUNCTION public.debit_for_withdrawal(UUID, BIGINT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO service_role;
