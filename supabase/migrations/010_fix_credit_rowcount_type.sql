-- Kay's Pay: Fix credit_wallet_funding row-count type bug
-- =====================================================================
-- v_inserted was declared BOOLEAN but holds GET DIAGNOSTICS ROW_COUNT (an
-- integer) and is compared with `= 0`, causing:
--   "operator does not exist: boolean = integer" (42883)
-- which made EVERY wallet credit fail. Declare it as INTEGER.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.credit_wallet_funding(
  p_user_id   UUID,
  p_reference TEXT,
  p_amount    BIGINT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_balance  BIGINT;
  v_inserted INTEGER := 0;
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

  -- Self-heal: make sure the profile + wallet exist for this auth user.
  INSERT INTO public.users (id) VALUES (p_user_id) ON CONFLICT (id) DO NOTHING;
  INSERT INTO wallets (user_id) VALUES (p_user_id) ON CONFLICT (user_id) DO NOTHING;

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

GRANT EXECUTE ON FUNCTION public.credit_wallet_funding(UUID, TEXT, BIGINT) TO service_role;
