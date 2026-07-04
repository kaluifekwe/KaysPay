-- Kay's Pay: Secure, server-authoritative money layer
-- =====================================================================
-- This migration makes the wallet ledger tamper-proof:
--   1. Removes the arbitrary-SQL backdoor (exec_sql).
--   2. Adds idempotency primitives (processed_payments + unique tx keys).
--   3. Adds atomic, row-locked RPCs for every credit/debit path.
--   4. Revokes ALL direct write access to money tables from clients.
--      After this runs, the ONLY way money moves is via these RPCs,
--      which are called exclusively by JWT-authenticated Edge Functions
--      using the service-role key.
--
-- DEPLOY ORDER: deploy the new Edge Functions and ship the new app build
-- BEFORE applying this migration, otherwise the live client (which writes
-- balances directly) will start failing as soon as the REVOKEs land.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. Remove the arbitrary SQL execution backdoor
-- ---------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.exec_sql(text);

-- ---------------------------------------------------------------------
-- 1. Idempotency primitives
-- ---------------------------------------------------------------------

-- One row per successfully-processed Paystack funding reference.
-- The PRIMARY KEY on `reference` is what makes wallet funding idempotent:
-- the same payment can be verified by both the client AND the webhook
-- without ever double-crediting.
CREATE TABLE IF NOT EXISTS processed_payments (
  reference   TEXT PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  amount_ngn  NUMERIC(15,2) NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE processed_payments ENABLE ROW LEVEL SECURITY;
-- No client policies: this table is server-only.

-- Unique guard for service purchases (airtime/data/bills/etc).
-- Prevents a retried/double-tapped purchase from debiting twice.
CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_idempotency_key
  ON transactions ((metadata->>'idempotency_key'))
  WHERE metadata ? 'idempotency_key';

-- Helpful operational indexes.
CREATE INDEX IF NOT EXISTS idx_transactions_user_created
  ON transactions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_status
  ON transactions (status);

-- ---------------------------------------------------------------------
-- 2. Atomic money-movement functions (SECURITY DEFINER)
--    Each one locks the wallet row (FOR UPDATE) so concurrent requests
--    for the same user serialize correctly under load.
-- ---------------------------------------------------------------------

-- Credit a wallet from a verified Paystack payment. Idempotent on reference.
-- Returns: { credited: bool, balance: numeric, amount: numeric }
CREATE OR REPLACE FUNCTION public.credit_wallet_funding(
  p_user_id   UUID,
  p_reference TEXT,
  p_amount    NUMERIC
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_balance NUMERIC;
  v_inserted BOOLEAN := FALSE;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT';
  END IF;

  -- Claim the reference. If it already exists, this is a replay.
  INSERT INTO processed_payments (reference, user_id, amount_ngn)
  VALUES (p_reference, p_user_id, p_amount)
  ON CONFLICT (reference) DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  IF v_inserted = 0 THEN
    -- Already processed: return current balance, do NOT credit again.
    SELECT balance INTO v_balance FROM wallets WHERE user_id = p_user_id;
    RETURN jsonb_build_object('credited', false, 'balance', COALESCE(v_balance, 0), 'amount', p_amount);
  END IF;

  -- First time: lock the wallet and credit.
  SELECT balance INTO v_balance FROM wallets WHERE user_id = p_user_id FOR UPDATE;
  IF v_balance IS NULL THEN
    RAISE EXCEPTION 'WALLET_NOT_FOUND';
  END IF;

  UPDATE wallets
     SET balance = balance + p_amount, updated_at = now()
   WHERE user_id = p_user_id;

  INSERT INTO transactions (user_id, type, amount_ngn, status, metadata, completed_at)
  VALUES (p_user_id, 'wallet_fund', p_amount, 'completed',
          jsonb_build_object('source', 'paystack', 'reference', p_reference), now());

  RETURN jsonb_build_object('credited', true, 'balance', v_balance + p_amount, 'amount', p_amount);
END;
$$;

-- Atomically debit a wallet for a service purchase and create a PENDING
-- transaction. Idempotent on p_idempotency_key. Returns the transaction id.
CREATE OR REPLACE FUNCTION public.debit_for_service(
  p_user_id          UUID,
  p_amount           NUMERIC,
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
  v_balance NUMERIC;
  v_tx_id   UUID;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT';
  END IF;

  -- Idempotency: if this key was already used, return the existing tx.
  SELECT id INTO v_tx_id
    FROM transactions
   WHERE metadata->>'idempotency_key' = p_idempotency_key
   LIMIT 1;
  IF v_tx_id IS NOT NULL THEN
    RETURN v_tx_id;
  END IF;

  -- Lock wallet row and verify funds.
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

  INSERT INTO transactions (user_id, type, recipient_phone, network, amount_ngn, status, metadata)
  VALUES (p_user_id, p_type, p_recipient, COALESCE(p_network, 'N/A'), p_amount, 'pending',
          COALESCE(p_metadata, '{}'::jsonb) || jsonb_build_object('idempotency_key', p_idempotency_key))
  RETURNING id INTO v_tx_id;

  RETURN v_tx_id;
END;
$$;

-- Mark a pending service transaction as completed.
CREATE OR REPLACE FUNCTION public.complete_service_transaction(
  p_tx_id    UUID,
  p_order_id TEXT
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE transactions
     SET status = 'completed',
         vtu_order_id = p_order_id,
         completed_at = now()
   WHERE id = p_tx_id AND status = 'pending';
END;
$$;

-- Refund a pending service transaction (provider rejected/failed). Idempotent:
-- only refunds while the tx is still 'pending', so it can be called safely once.
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
  v_amount  NUMERIC;
BEGIN
  -- Lock the tx; bail if it is not refundable.
  SELECT user_id, amount_ngn INTO v_user_id, v_amount
    FROM transactions
   WHERE id = p_tx_id AND status = 'pending'
   FOR UPDATE;

  IF v_user_id IS NULL THEN
    RETURN; -- already settled or not found; nothing to refund
  END IF;

  UPDATE wallets
     SET balance = balance + v_amount, updated_at = now()
   WHERE user_id = v_user_id;

  UPDATE transactions
     SET status = 'failed',
         metadata = COALESCE(metadata, '{}'::jsonb)
                    || jsonb_build_object('failure_reason', COALESCE(p_reason, 'provider_error'),
                                          'refunded', true)
   WHERE id = p_tx_id;
END;
$$;

-- Atomically debit for a withdrawal AND create the withdrawal + pending
-- transaction records in one transaction, so a debit can never exist without
-- a matching record. Returns { balance, withdrawal_id }.
CREATE OR REPLACE FUNCTION public.debit_for_withdrawal(
  p_user_id        UUID,
  p_amount         NUMERIC,
  p_reference      TEXT,
  p_bank_name      TEXT,
  p_bank_code      TEXT,
  p_account_number TEXT,
  p_account_name   TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_balance       NUMERIC;
  v_withdrawal_id UUID;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT';
  END IF;

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
                           account_number, account_name, status, paystack_reference)
  VALUES (p_user_id, p_amount, p_bank_name, p_bank_code,
          p_account_number, p_account_name, 'processing', p_reference)
  RETURNING id INTO v_withdrawal_id;

  INSERT INTO transactions (user_id, type, amount_ngn, status, metadata)
  VALUES (p_user_id, 'withdrawal', p_amount, 'pending',
          jsonb_build_object('bank_name', p_bank_name, 'bank_code', p_bank_code,
                             'account_number', p_account_number, 'account_name', p_account_name,
                             'paystack_reference', p_reference));

  RETURN jsonb_build_object('balance', v_balance - p_amount, 'withdrawal_id', v_withdrawal_id);
END;
$$;

-- Refund a withdrawal that Paystack reported failed/reversed. Idempotent:
-- only refunds when the withdrawal is not already failed/refunded.
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
  v_amount  NUMERIC;
BEGIN
  SELECT user_id, amount_ngn INTO v_user_id, v_amount
    FROM withdrawals
   WHERE paystack_reference = p_reference
     AND status NOT IN ('failed')
   FOR UPDATE;

  IF v_user_id IS NULL THEN
    RETURN; -- unknown or already failed/refunded
  END IF;

  UPDATE wallets
     SET balance = balance + v_amount, updated_at = now()
   WHERE user_id = v_user_id;

  UPDATE withdrawals
     SET status = 'failed', failure_reason = p_reason
   WHERE paystack_reference = p_reference;

  INSERT INTO transactions (user_id, type, amount_ngn, status, metadata, completed_at)
  VALUES (v_user_id, 'refund', v_amount, 'completed',
          jsonb_build_object('reason', p_reason, 'reference', p_reference), now());
END;
$$;

-- Mark a withdrawal completed (transfer.success webhook).
CREATE OR REPLACE FUNCTION public.complete_withdrawal_by_reference(
  p_reference TEXT
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE withdrawals
     SET status = 'completed', completed_at = now()
   WHERE paystack_reference = p_reference AND status <> 'completed';

  UPDATE transactions
     SET status = 'completed', completed_at = now()
   WHERE metadata->>'paystack_reference' = p_reference
     AND type = 'withdrawal' AND status = 'pending';
END;
$$;

-- ---------------------------------------------------------------------
-- 3. Lock down direct client access to money tables
--    Clients keep SELECT (via existing RLS policies) but lose all
--    write access. Money only moves through the RPCs above.
-- ---------------------------------------------------------------------
REVOKE INSERT, UPDATE, DELETE ON wallets       FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON transactions  FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON withdrawals   FROM anon, authenticated;
REVOKE ALL                    ON processed_payments FROM anon, authenticated;

-- Drop the client write policies added in 004 (the edge function uses
-- the service role, which bypasses RLS, so these are unnecessary and unsafe).
DROP POLICY IF EXISTS "Users can insert own withdrawals" ON withdrawals;
DROP POLICY IF EXISTS "Users can update own withdrawals" ON withdrawals;

-- The RPCs must only be callable by the service role (i.e. from Edge
-- Functions), never directly by a logged-in client.
REVOKE EXECUTE ON FUNCTION public.credit_wallet_funding(UUID, TEXT, NUMERIC)      FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.debit_for_service(UUID, NUMERIC, TEXT, TEXT, TEXT, JSONB, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.complete_service_transaction(UUID, TEXT)        FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.refund_service_transaction(UUID, TEXT)          FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.debit_for_withdrawal(UUID, NUMERIC, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.refund_withdrawal_by_reference(TEXT, TEXT)      FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.complete_withdrawal_by_reference(TEXT)          FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.credit_wallet_funding(UUID, TEXT, NUMERIC)       TO service_role;
GRANT EXECUTE ON FUNCTION public.debit_for_service(UUID, NUMERIC, TEXT, TEXT, TEXT, JSONB, TEXT)  TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_service_transaction(UUID, TEXT)         TO service_role;
GRANT EXECUTE ON FUNCTION public.refund_service_transaction(UUID, TEXT)           TO service_role;
GRANT EXECUTE ON FUNCTION public.debit_for_withdrawal(UUID, NUMERIC, TEXT, TEXT, TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.refund_withdrawal_by_reference(TEXT, TEXT)       TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_withdrawal_by_reference(TEXT)           TO service_role;
