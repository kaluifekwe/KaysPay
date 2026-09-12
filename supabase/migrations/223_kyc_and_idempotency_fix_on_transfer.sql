-- Closes two real gaps found by a Strix pentest scan 2026-09-12, both in
-- the bank-transfer cash-out path -- the highest-value money-OUT route in
-- the app (NGN leaving to an external bank account), yet the one migration
-- 222 didn't touch.
--
-- 1. No KYC check at all. migration 222 gated debit_for_service (purchases)
--    but never debit_for_transfer, so an unverified account with any
--    balance (including one credited via crypto-sell settlement, which also
--    has no KYC check) could cash out to any bank account.
--
-- 2. The idempotency short-circuit was globally unscoped -- identical to
--    the pre-222 debit_for_service bug, and the same class Strix already
--    found in crypto-sell/esim-purchase on 2026-08-20. Reusing ANY existing
--    idempotency key (own or another user's) returned that old transaction
--    id without debiting the wallet, checking KYC, or re-validating the
--    request -- while the caller (transfer-send) still went on to instruct
--    the provider to actually send money.
CREATE OR REPLACE FUNCTION public.debit_for_transfer(
  p_user_id uuid,
  p_amount bigint,
  p_recipient_name text,
  p_recipient_account_number text,
  p_recipient_bank_code text,
  p_recipient_bank_name text,
  p_provider text,
  p_idempotency_key text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_balance        BIGINT;
  v_tx_id          UUID;
  v_today_total    BIGINT;
  v_kyc_status     TEXT;
  v_existing_user  UUID;
  v_existing_amount BIGINT;
  v_existing_account TEXT;
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

  SELECT id, user_id, amount_ngn, metadata->>'recipient_account_number'
    INTO v_tx_id, v_existing_user, v_existing_amount, v_existing_account
    FROM transactions
   WHERE metadata->>'idempotency_key' = p_idempotency_key
   LIMIT 1;
  IF v_tx_id IS NOT NULL THEN
    IF v_existing_user = p_user_id AND v_existing_amount = p_amount
       AND v_existing_account IS NOT DISTINCT FROM p_recipient_account_number THEN
      RETURN v_tx_id;
    ELSE
      RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSE';
    END IF;
  END IF;

  SELECT status INTO v_kyc_status FROM user_kyc WHERE user_id = p_user_id;
  IF v_kyc_status IS DISTINCT FROM 'verified' THEN
    RAISE EXCEPTION 'KYC_NOT_VERIFIED';
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
$function$;
