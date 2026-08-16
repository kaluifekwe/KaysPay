-- Crypto buy/sell/withdraw, built ahead of Yellow Card's approval (per owner
-- request) so the app-side pieces are ready the moment their API access
-- lands — only _shared/yellowcard-client.ts needs a real implementation
-- then. Buy/sell are pure internal ledger swaps (NGN wallet <-> crypto
-- balance) and need no provider at all, so they're fully live today, just
-- gated behind CRYPTO_ENABLED client-side until the owner is ready to show
-- real users. Withdrawal to an external wallet needs a real on-chain
-- broadcast, so its RPC exists but the edge function refuses to run it
-- while the provider isn't configured — see crypto-withdraw/index.ts.

ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_type_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_type_check
  CHECK (type = ANY (ARRAY[
    'airtime'::text, 'data'::text, 'bill'::text, 'exam_pin'::text,
    'foreign_number'::text, 'card_fund'::text, 'payroll'::text,
    'wallet_fund'::text, 'refund'::text, 'withdrawal'::text, 'esim'::text,
    'nin_verification'::text, 'nin_validation'::text,
    'bvn_verification'::text, 'nin_name_modification'::text,
    'nin_phone_modification'::text, 'nin_address_modification'::text,
    'crypto_buy'::text, 'crypto_sell'::text, 'crypto_withdraw'::text
  ]));

-- One row per (user, asset). balance_micro is the asset's smallest unit
-- scaled to 6 decimals (matches USDT's own precision) — e.g. 5.5 USDT is
-- stored as 5500000. Only ever written through the RPCs below; RLS grants
-- the owner read-only access, same as `wallets`.
CREATE TABLE public.crypto_balances (
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  asset         TEXT NOT NULL CHECK (asset IN ('USDT')),
  balance_micro BIGINT NOT NULL DEFAULT 0 CHECK (balance_micro >= 0),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, asset)
);
ALTER TABLE public.crypto_balances ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.crypto_balances FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.crypto_balances TO service_role;
CREATE POLICY "Users can view own crypto balance" ON public.crypto_balances
  FOR SELECT USING (auth.uid() = user_id);
GRANT SELECT ON public.crypto_balances TO authenticated;

-- Labeled external wallet addresses (the "save trusted address" shortcut
-- from the agreed withdrawal-safety flow). No money moves through this
-- table — it's just the user's own address book, so plain RLS CRUD is fine
-- (no RPC needed, unlike balances).
CREATE TABLE public.crypto_saved_addresses (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  asset        TEXT NOT NULL CHECK (asset IN ('USDT')),
  network      TEXT NOT NULL CHECK (network IN ('TRC20', 'ERC20', 'BEP20')),
  address      TEXT NOT NULL CHECK (length(address) BETWEEN 10 AND 100),
  label        TEXT CHECK (label IS NULL OR length(label) <= 60),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, asset, network, address)
);
ALTER TABLE public.crypto_saved_addresses ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.crypto_saved_addresses FROM PUBLIC, anon;
CREATE POLICY "Users manage own saved crypto addresses" ON public.crypto_saved_addresses
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.crypto_saved_addresses TO authenticated;

-- Buy: NGN wallet -> crypto balance. A single atomic swap — no provider
-- call, no pending state, so it completes immediately unlike debit_for_
-- service's pending-then-settle shape.
CREATE OR REPLACE FUNCTION public.buy_crypto(
  p_user_id         UUID,
  p_asset           TEXT,
  p_ngn_kobo        BIGINT,
  p_crypto_micro    BIGINT,
  p_rate            NUMERIC,
  p_idempotency_key TEXT
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_balance BIGINT;
  v_tx_id   UUID;
BEGIN
  IF p_ngn_kobo IS NULL OR p_ngn_kobo <= 0 OR p_crypto_micro IS NULL OR p_crypto_micro <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT';
  END IF;

  SELECT id INTO v_tx_id FROM transactions
   WHERE metadata->>'idempotency_key' = p_idempotency_key LIMIT 1;
  IF v_tx_id IS NOT NULL THEN
    RETURN v_tx_id;
  END IF;

  SELECT balance INTO v_balance FROM wallets WHERE user_id = p_user_id FOR UPDATE;
  IF v_balance IS NULL THEN
    RAISE EXCEPTION 'WALLET_NOT_FOUND';
  END IF;
  IF v_balance < p_ngn_kobo THEN
    RAISE EXCEPTION 'INSUFFICIENT_FUNDS';
  END IF;

  UPDATE wallets SET balance = balance - p_ngn_kobo, updated_at = now() WHERE user_id = p_user_id;

  INSERT INTO crypto_balances (user_id, asset, balance_micro)
  VALUES (p_user_id, p_asset, p_crypto_micro)
  ON CONFLICT (user_id, asset) DO UPDATE
    SET balance_micro = crypto_balances.balance_micro + EXCLUDED.balance_micro,
        updated_at = now();

  INSERT INTO transactions (user_id, type, recipient_phone, network, amount_ngn, status, metadata, completed_at)
  VALUES (p_user_id, 'crypto_buy', p_asset, 'N/A', p_ngn_kobo, 'completed',
          jsonb_build_object('asset', p_asset, 'crypto_micro', p_crypto_micro, 'rate', p_rate,
                              'idempotency_key', p_idempotency_key),
          now())
  RETURNING id INTO v_tx_id;

  RETURN v_tx_id;
END;
$$;
REVOKE ALL ON FUNCTION public.buy_crypto(UUID, TEXT, BIGINT, BIGINT, NUMERIC, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.buy_crypto(UUID, TEXT, BIGINT, BIGINT, NUMERIC, TEXT) TO service_role;

-- Sell: crypto balance -> NGN wallet. Mirror of buy_crypto.
CREATE OR REPLACE FUNCTION public.sell_crypto(
  p_user_id         UUID,
  p_asset           TEXT,
  p_ngn_kobo        BIGINT,
  p_crypto_micro    BIGINT,
  p_rate            NUMERIC,
  p_idempotency_key TEXT
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_crypto_balance BIGINT;
  v_tx_id          UUID;
BEGIN
  IF p_ngn_kobo IS NULL OR p_ngn_kobo <= 0 OR p_crypto_micro IS NULL OR p_crypto_micro <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT';
  END IF;

  SELECT id INTO v_tx_id FROM transactions
   WHERE metadata->>'idempotency_key' = p_idempotency_key LIMIT 1;
  IF v_tx_id IS NOT NULL THEN
    RETURN v_tx_id;
  END IF;

  SELECT balance_micro INTO v_crypto_balance FROM crypto_balances
   WHERE user_id = p_user_id AND asset = p_asset FOR UPDATE;
  IF v_crypto_balance IS NULL OR v_crypto_balance < p_crypto_micro THEN
    RAISE EXCEPTION 'INSUFFICIENT_CRYPTO_BALANCE';
  END IF;

  UPDATE crypto_balances SET balance_micro = balance_micro - p_crypto_micro, updated_at = now()
   WHERE user_id = p_user_id AND asset = p_asset;

  UPDATE wallets SET balance = balance + p_ngn_kobo, updated_at = now() WHERE user_id = p_user_id;

  INSERT INTO transactions (user_id, type, recipient_phone, network, amount_ngn, status, metadata, completed_at)
  VALUES (p_user_id, 'crypto_sell', p_asset, 'N/A', p_ngn_kobo, 'completed',
          jsonb_build_object('asset', p_asset, 'crypto_micro', p_crypto_micro, 'rate', p_rate,
                              'idempotency_key', p_idempotency_key),
          now())
  RETURNING id INTO v_tx_id;

  RETURN v_tx_id;
END;
$$;
REVOKE ALL ON FUNCTION public.sell_crypto(UUID, TEXT, BIGINT, BIGINT, NUMERIC, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sell_crypto(UUID, TEXT, BIGINT, BIGINT, NUMERIC, TEXT) TO service_role;

-- Withdrawal to an external wallet: debits crypto_balances into a PENDING
-- transaction (mirrors debit_for_service's shape, since a real on-chain
-- broadcast is genuinely async and can fail) — not callable end-to-end yet
-- since crypto-withdraw/index.ts refuses to run while Yellow Card isn't
-- configured, but ready the moment it is.
CREATE OR REPLACE FUNCTION public.debit_crypto_for_withdrawal(
  p_user_id         UUID,
  p_asset           TEXT,
  p_crypto_micro    BIGINT,
  p_network         TEXT,
  p_address         TEXT,
  p_idempotency_key TEXT
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_crypto_balance BIGINT;
  v_tx_id          UUID;
BEGIN
  IF p_crypto_micro IS NULL OR p_crypto_micro <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT';
  END IF;

  SELECT id INTO v_tx_id FROM transactions
   WHERE metadata->>'idempotency_key' = p_idempotency_key LIMIT 1;
  IF v_tx_id IS NOT NULL THEN
    RETURN v_tx_id;
  END IF;

  SELECT balance_micro INTO v_crypto_balance FROM crypto_balances
   WHERE user_id = p_user_id AND asset = p_asset FOR UPDATE;
  IF v_crypto_balance IS NULL OR v_crypto_balance < p_crypto_micro THEN
    RAISE EXCEPTION 'INSUFFICIENT_CRYPTO_BALANCE';
  END IF;

  UPDATE crypto_balances SET balance_micro = balance_micro - p_crypto_micro, updated_at = now()
   WHERE user_id = p_user_id AND asset = p_asset;

  INSERT INTO transactions (user_id, type, recipient_phone, network, amount_ngn, status, metadata)
  VALUES (p_user_id, 'crypto_withdraw', p_address, 'N/A', 0, 'pending',
          jsonb_build_object('asset', p_asset, 'crypto_micro', p_crypto_micro,
                              'crypto_network', p_network, 'address', p_address,
                              'idempotency_key', p_idempotency_key))
  RETURNING id INTO v_tx_id;

  RETURN v_tx_id;
END;
$$;
REVOKE ALL ON FUNCTION public.debit_crypto_for_withdrawal(UUID, TEXT, BIGINT, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.debit_crypto_for_withdrawal(UUID, TEXT, BIGINT, TEXT, TEXT, TEXT) TO service_role;

-- Refund path for a failed/rejected on-chain broadcast — returns the crypto
-- to the user's balance, same "only while still pending" safety as
-- refund_service_transaction.
CREATE OR REPLACE FUNCTION public.refund_crypto_withdrawal(
  p_tx_id UUID,
  p_reason TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user_id UUID;
  v_asset   TEXT;
  v_micro   BIGINT;
BEGIN
  SELECT user_id, metadata->>'asset', (metadata->>'crypto_micro')::BIGINT
    INTO v_user_id, v_asset, v_micro
    FROM transactions
   WHERE id = p_tx_id AND status = 'pending' AND type = 'crypto_withdraw'
   FOR UPDATE;

  IF v_user_id IS NULL THEN
    RETURN;
  END IF;

  UPDATE crypto_balances SET balance_micro = balance_micro + v_micro, updated_at = now()
   WHERE user_id = v_user_id AND asset = v_asset;

  UPDATE transactions
     SET status = 'failed',
         metadata = COALESCE(metadata, '{}'::jsonb)
                    || jsonb_build_object('failure_reason', COALESCE(p_reason, 'provider_error'), 'refunded', true)
   WHERE id = p_tx_id;
END;
$$;
REVOKE ALL ON FUNCTION public.refund_crypto_withdrawal(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.refund_crypto_withdrawal(UUID, TEXT) TO service_role;
