-- Wallet Transfer (phase 1, Flutterwave): the first outbound-money feature
-- in the app. Every other feature either receives money in or spends it on
-- a non-cash-out service (VTU, crypto that lands in the user's own
-- regulated Quidax sub-account) — this lets a user send real NGN from their
-- KaysPay balance to any external bank account. Mirrors debit_for_service's
-- exact discipline (idempotency-key short-circuit BEFORE the lock, FOR
-- UPDATE row lock, balance check, atomic debit + pending transaction row in
-- one statement) rather than the abandoned 'withdrawal' scaffolding from
-- migrations 005-008 (Paystack-only, a different idempotency-key column and
-- {status,data} response convention, never wired to an edge function —
-- confirmed dead code, deliberately not reused here).
--
-- No new complete/refund RPCs: settlement reuses the existing generic
-- complete_service_transaction(p_tx_id, p_order_id) (p_order_id becomes the
-- provider's transfer reference), and failure reuses the existing
-- refund_service_transaction_confirmed(p_tx_id, p_reason, p_origin) — both
-- already idempotent (status-guarded). The only change either needs is
-- adding 'transfer' to the refund function's type allowlist below.
--
-- Transfers never use cashback (debit_for_transfer has no p_use_cashback
-- param, cashback_used_kobo stays 0/NULL) — a promotional credit should
-- never be directly cashable-out via a bank transfer.

ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_type_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_type_check
  CHECK (type = ANY (ARRAY[
    'airtime'::text, 'data'::text, 'bill'::text, 'exam_pin'::text,
    'foreign_number'::text, 'card_fund'::text, 'payroll'::text,
    'wallet_fund'::text, 'refund'::text, 'withdrawal'::text, 'esim'::text,
    'nin_verification'::text, 'nin_validation'::text,
    'bvn_verification'::text, 'nin_name_modification'::text,
    'nin_phone_modification'::text, 'nin_address_modification'::text,
    'crypto_buy'::text, 'crypto_sell'::text, 'crypto_withdraw'::text,
    'crypto_deposit'::text, 'transfer'::text
  ]));

-- Kill switch, same shape as the 'identity'/'nin_modification' split in
-- migration 113 — lets Transfer be turned off instantly without touching
-- any other service.
ALTER TABLE public.service_controls DROP CONSTRAINT IF EXISTS service_controls_service_check;
ALTER TABLE public.service_controls ADD CONSTRAINT service_controls_service_check
  CHECK (service IN ('vtu','esim','foreign_number','identity','nin_modification','transfer'));
INSERT INTO public.service_controls(service) VALUES ('transfer')
ON CONFLICT (service) DO NOTHING;

-- v1 limits are flat placeholder constants, matching the precedent set by
-- crypto-buy's FALLBACK_MIN_NGN/MAX_NGN and crypto-sell's MIN_USDT/MAX_USDT
-- (this app has no KYC-tier system to gate on — confirmed during planning,
-- user_kyc.status is a flat verified/unverified boolean with no existing
-- amount-limit mechanism anywhere). These are intentionally conservative
-- and meant to be tuned by the owner; an admin-configurable limits table
-- (mirroring service_pricing's pattern) is a reasonable fast-follow, not
-- built here to keep phase 1 scoped.
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

  -- Idempotency short-circuit BEFORE the lock — a retry with the same key
  -- returns the original transaction id without debiting again.
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

  -- Rolling daily cap — sums today's non-refunded transfers (pending or
  -- completed; a refunded one no longer counts against the cap). New ground
  -- for this codebase (no existing SUM-based amount cap anywhere), kept
  -- inside the same atomic statement as the debit rather than a separate
  -- pre-check, so a race between two concurrent transfers can't both pass
  -- the check before either commits (the wallet row lock above already
  -- serializes this per user).
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
    p_user_id, 'transfer', p_recipient_account_number, p_recipient_bank_name, p_amount, 'pending',
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

-- Extend the refund allowlist so the existing generic refund RPC also
-- covers 'transfer' — same body as migration 126, just with 'transfer'
-- added to both v_type checks, so refund logic stays in exactly one place.
CREATE OR REPLACE FUNCTION public.refund_service_transaction_confirmed(
  p_tx_id UUID,
  p_reason TEXT,
  p_origin TEXT DEFAULT 'automatic'
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user_id UUID;
  v_amount BIGINT;
  v_cashback_used BIGINT;
  v_wallet_amount BIGINT;
  v_status TEXT;
  v_type TEXT;
  v_refunded BOOLEAN;
  v_wallet_updated INTEGER := 0;
  v_reason TEXT := left(COALESCE(NULLIF(trim(p_reason), ''), 'provider_error'), 500);
BEGIN
  IF p_origin NOT IN ('automatic','reconcile','webhook','admin','legacy') THEN
    RAISE EXCEPTION 'INVALID_REFUND_ORIGIN';
  END IF;

  SELECT user_id, amount_ngn, status, type, COALESCE((metadata->>'refunded')::BOOLEAN, FALSE), COALESCE(cashback_used_kobo, 0)
    INTO v_user_id, v_amount, v_status, v_type, v_refunded, v_cashback_used
    FROM public.transactions WHERE id = p_tx_id FOR UPDATE;

  IF v_user_id IS NULL THEN RETURN FALSE; END IF;
  IF v_type NOT IN (
    'airtime','data','bill','exam_pin','esim','foreign_number',
    'nin_verification','nin_validation','bvn_verification',
    'nin_name_modification','nin_phone_modification','nin_address_modification',
    'transfer'
  ) THEN RETURN FALSE; END IF;
  IF v_refunded THEN
    RETURN EXISTS (SELECT 1 FROM public.service_refunds WHERE transaction_id = p_tx_id);
  END IF;
  IF v_status <> 'pending' OR v_amount IS NULL OR v_amount <= 0 THEN RETURN FALSE; END IF;

  v_wallet_amount := v_amount - v_cashback_used;

  UPDATE public.wallets SET balance = balance + v_wallet_amount, updated_at = now()
  WHERE user_id = v_user_id;
  GET DIAGNOSTICS v_wallet_updated = ROW_COUNT;
  IF v_wallet_updated <> 1 THEN RETURN FALSE; END IF;

  UPDATE public.transactions
  SET status = 'refunded',
      metadata = COALESCE(metadata, '{}'::JSONB)
        || jsonb_build_object('failure_reason', v_reason, 'refunded', true)
  WHERE id = p_tx_id;

  INSERT INTO public.service_refunds(transaction_id, user_id, amount_kobo, reason, origin, refund_mode)
  VALUES (p_tx_id, v_user_id, v_wallet_amount, v_reason, p_origin, 'pending')
  ON CONFLICT (transaction_id) DO NOTHING;

  UPDATE public.service_refund_recovery
  SET resolved_at = now(), resolution = 'refunded', last_attempt_at = now(), attempts = attempts + 1
  WHERE transaction_id = p_tx_id AND resolved_at IS NULL;
  RETURN TRUE;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.refund_service_transaction_confirmed(UUID,TEXT,TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refund_service_transaction_confirmed(UUID,TEXT,TEXT) TO service_role;
