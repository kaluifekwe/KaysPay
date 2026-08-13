-- Phase 1 of the Quidax integration: sub-account foundation + crypto
-- deposits. Each KaysPay user gets their own Quidax sub-account (created
-- lazily on first visit to the Crypto section) — their crypto balance lives
-- at Quidax under their own identity, never pooled into a KaysPay-held
-- balance. This migration adds no money-movement RPCs at all; deposits are
-- entirely Quidax-side (on-chain, into the user's own sub-account) and only
-- get mirrored into `transactions` for History/receipts once confirmed.

CREATE TABLE public.crypto_accounts (
  user_id         UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  quidax_user_id  TEXT NOT NULL UNIQUE,
  quidax_sn       TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.crypto_accounts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.crypto_accounts FROM PUBLIC, anon;
CREATE POLICY "Users can view own crypto account" ON public.crypto_accounts
  FOR SELECT USING (auth.uid() = user_id);
GRANT SELECT ON public.crypto_accounts TO authenticated;
GRANT ALL ON public.crypto_accounts TO service_role;

-- crypto_deposit joins the existing crypto_buy/crypto_sell/crypto_withdraw
-- types from migration 082 — a deposit from an external wallet (Binance,
-- Bybit, etc.) into the user's own Quidax sub-account, confirmed via
-- webhook. amount_ngn is always 0 here; the crypto amount/asset live in
-- metadata, same convention as the existing crypto transaction types.
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
    'crypto_deposit'::text
  ]));

-- Records a confirmed Quidax deposit into transactions (idempotent on the
-- Quidax deposit id, since webhooks can retry) — called only from the
-- webhook handler, never client-reachable.
CREATE OR REPLACE FUNCTION public.record_crypto_deposit(
  p_user_id       UUID,
  p_asset         TEXT,
  p_crypto_micro  BIGINT,
  p_network       TEXT,
  p_quidax_deposit_id TEXT,
  p_txid          TEXT
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tx_id UUID;
BEGIN
  IF p_crypto_micro IS NULL OR p_crypto_micro <= 0 OR p_quidax_deposit_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_DEPOSIT';
  END IF;

  SELECT id INTO v_tx_id FROM transactions
   WHERE metadata->>'quidax_deposit_id' = p_quidax_deposit_id LIMIT 1;
  IF v_tx_id IS NOT NULL THEN
    RETURN v_tx_id;
  END IF;

  INSERT INTO transactions (user_id, type, recipient_phone, network, amount_ngn, status, metadata, completed_at)
  VALUES (p_user_id, 'crypto_deposit', p_asset, 'N/A', 0, 'completed',
          jsonb_build_object('asset', p_asset, 'crypto_micro', p_crypto_micro,
                              'crypto_network', p_network, 'quidax_deposit_id', p_quidax_deposit_id,
                              'txid', p_txid),
          now())
  RETURNING id INTO v_tx_id;

  RETURN v_tx_id;
END;
$$;
REVOKE ALL ON FUNCTION public.record_crypto_deposit(UUID, TEXT, BIGINT, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_crypto_deposit(UUID, TEXT, BIGINT, TEXT, TEXT, TEXT) TO service_role;
