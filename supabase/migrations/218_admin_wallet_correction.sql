-- One-off (but reusable) tool for manually correcting a wallet balance when
-- money has already moved outside the normal in-app flow -- e.g. a customer
-- funded their wallet intending to buy crypto (which is paid by direct bank
-- transfer, never from the wallet), the purchase never happened, support
-- refunded them manually via bank transfer, but the original funding is
-- still sitting in their in-app wallet and needs to come back out. Same
-- allow-list-extension pattern every prior new transaction type has followed
-- (013, 018, 026, 033, 082, 117, 128, 213).
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
    'crypto_deposit'::text, 'crypto_swap'::text, 'transfer'::text,
    'wallet_correction'::text
  ]));

-- Debits a wallet by exactly p_amount_kobo, recording a transactions row as
-- the audit trail (metadata carries the admin who authorized it and why).
-- Never allows the balance to go negative -- caps at whatever is actually
-- present, same discipline as every other debit path in this codebase.
CREATE OR REPLACE FUNCTION public.admin_wallet_correction(
  p_admin_user_id UUID,
  p_user_id        UUID,
  p_amount_kobo    BIGINT,
  p_reason         TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_balance BIGINT;
  v_tx_id   UUID;
BEGIN
  IF p_amount_kobo IS NULL OR p_amount_kobo <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT';
  END IF;
  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'REASON_REQUIRED';
  END IF;

  SELECT balance INTO v_balance FROM wallets WHERE user_id = p_user_id FOR UPDATE;
  IF v_balance IS NULL THEN
    RAISE EXCEPTION 'WALLET_NOT_FOUND';
  END IF;
  IF v_balance < p_amount_kobo THEN
    RAISE EXCEPTION 'INSUFFICIENT_BALANCE';
  END IF;

  UPDATE wallets SET balance = balance - p_amount_kobo, updated_at = now()
  WHERE user_id = p_user_id;

  INSERT INTO transactions (user_id, type, amount_ngn, status, metadata, completed_at)
  VALUES (
    p_user_id, 'wallet_correction', p_amount_kobo, 'completed',
    jsonb_build_object(
      'direction', 'debit',
      'reason', left(p_reason, 300),
      'admin_user_id', p_admin_user_id
    ),
    now()
  )
  RETURNING id INTO v_tx_id;

  RETURN jsonb_build_object('transaction_id', v_tx_id, 'new_balance', v_balance - p_amount_kobo);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_wallet_correction(UUID,UUID,BIGINT,TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_wallet_correction(UUID,UUID,BIGINT,TEXT) TO service_role;
