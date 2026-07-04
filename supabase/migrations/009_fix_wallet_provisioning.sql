-- Kay's Pay: Fix profile/wallet provisioning
-- =====================================================================
-- Migration 002 tried to relink public.users to auth.users but used
-- CREATE TABLE IF NOT EXISTS, so on the pre-existing table it was a no-op.
-- Result: some auth users have no public.users / wallets row, so funding
-- fails with WALLET_NOT_FOUND. This migration:
--   1. Makes users.phone null-safe (it was NOT NULL UNIQUE; empty strings
--      collided for email-only users).
--   2. Backfills missing profiles + wallets for every auth user.
--   3. Hardens the signup trigger (conflict-safe, null phone).
--   4. Makes credit_wallet_funding self-healing (auto-creates the wallet).
-- =====================================================================

-- 1. Null-safe phone (multiple NULLs are allowed by UNIQUE; multiple '' are not)
ALTER TABLE users ALTER COLUMN phone DROP NOT NULL;
UPDATE users SET phone = NULL WHERE phone = '';

-- 2a. Backfill profiles for auth users missing one
INSERT INTO public.users (id, phone)
SELECT au.id, NULLIF(au.phone, '')
FROM auth.users au
LEFT JOIN public.users pu ON pu.id = au.id
WHERE pu.id IS NULL;

-- 2b. Backfill wallets for profiles missing one
INSERT INTO wallets (user_id)
SELECT pu.id
FROM public.users pu
LEFT JOIN wallets w ON w.user_id = pu.id
WHERE w.user_id IS NULL;

-- 3. Harden the new-user trigger: never collide, never block signup
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.users (id, phone, pin_hash)
  VALUES (
    NEW.id,
    NULLIF(COALESCE(NEW.phone, NEW.raw_user_meta_data->>'phone', ''), ''),
    NULLIF(NEW.raw_user_meta_data->>'pin_hash', '')
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 4. Self-healing credit: ensure the profile + wallet exist before crediting,
--    so a missing wallet can never fail a real payment again.
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
