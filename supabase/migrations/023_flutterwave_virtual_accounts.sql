-- Kay's Pay: Flutterwave OAuth token cache + generalize wallet-funding source
-- =====================================================================
-- Flutterwave's v4 API uses OAuth2 client-credentials tokens that expire in
-- only 10 minutes (vs. VTU.ng's ~7 days) — same single-row cache pattern as
-- vtu_ng_auth (migration 014), just refreshed far more often. Server-only.
--
-- Wallet funding is moving from Paystack-only (dedicated virtual accounts)
-- to also support Flutterwave (fixed virtual accounts), so
-- credit_wallet_funding's hardcoded metadata.source = 'paystack' is replaced
-- with a p_source parameter. Existing callers omit it and keep working
-- (defaults to 'paystack').
--
-- The existing `virtual_accounts` table is reused as-is for Flutterwave
-- records (customer_code -> Flutterwave customer id "cus_...", dva_id ->
-- Flutterwave virtual account id "van_..." — column names are generic
-- enough not to need renaming). It's truncated here because the only rows
-- in it are Paystack test-mode artifacts from a feature that was never
-- exposed to real users (gated behind DVA_LIVE_ENABLED = false throughout).
-- =====================================================================

CREATE TABLE IF NOT EXISTS flutterwave_auth (
  id         INT PRIMARY KEY DEFAULT 1 CHECK (id = 1), -- single row
  token      TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

ALTER TABLE flutterwave_auth ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON flutterwave_auth FROM anon, authenticated;

TRUNCATE TABLE virtual_accounts;

-- Postgres treats an added trailing parameter as a NEW overload, not a
-- replacement (bit us before, see migration 022) — drop the old 3-arg
-- signature first so PostgREST doesn't end up with two ambiguous candidates.
DROP FUNCTION IF EXISTS public.credit_wallet_funding(UUID, TEXT, BIGINT);

CREATE OR REPLACE FUNCTION public.credit_wallet_funding(
  p_user_id   UUID,
  p_reference TEXT,
  p_amount    BIGINT,
  p_source    TEXT DEFAULT 'paystack'
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
          jsonb_build_object('source', p_source, 'reference', p_reference), now());

  RETURN jsonb_build_object('credited', true, 'balance', v_balance + p_amount, 'amount', p_amount);
END;
$$;

GRANT EXECUTE ON FUNCTION public.credit_wallet_funding(UUID, TEXT, BIGINT, TEXT) TO service_role;
