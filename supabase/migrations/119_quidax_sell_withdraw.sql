-- Phase 2 of the Quidax integration: Sell (crypto -> NGN into the user's
-- KaysPay wallet) and Withdraw (crypto -> external wallet), both drawing on
-- the balance held in the user's OWN Quidax sub-account.
--
-- Critically, neither of these debits a local crypto ledger the way
-- migration 082's buy/sell/withdraw did: Quidax is the source of truth for
-- what a user actually holds, so a local "balance" would only ever be a
-- second copy that can drift. These functions therefore RECORD and SETTLE,
-- they never hold a crypto balance.
--
-- Both flows are genuinely async on Quidax's side (a confirmed swap comes
-- back "initiated", a withdrawal comes back "processing"), so each is a
-- pending row settled later by its webhook — the same shape debit_for_
-- service uses for VTU orders.

-- Grants note: every function here is revoked from anon/authenticated
-- explicitly, not just PUBLIC. Migration 117 revoked only PUBLIC and left
-- record_crypto_deposit callable by unauthenticated callers (fixed in 118);
-- this file follows the corrected pattern throughout.

-- Sell step 1: record the swap as pending. No wallet movement yet — the
-- user is only credited once Quidax confirms the swap actually completed.
CREATE OR REPLACE FUNCTION public.record_crypto_sell_pending(
  p_user_id         UUID,
  p_asset           TEXT,
  p_crypto_micro    BIGINT,
  p_swap_id         TEXT,
  p_quoted_ngn_kobo BIGINT,
  p_idempotency_key TEXT
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tx_id UUID;
BEGIN
  IF p_crypto_micro IS NULL OR p_crypto_micro <= 0 OR p_swap_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_SELL';
  END IF;

  SELECT id INTO v_tx_id FROM transactions
   WHERE metadata->>'idempotency_key' = p_idempotency_key LIMIT 1;
  IF v_tx_id IS NOT NULL THEN
    RETURN v_tx_id;
  END IF;

  INSERT INTO transactions (user_id, type, recipient_phone, network, amount_ngn, status, metadata)
  VALUES (p_user_id, 'crypto_sell', p_asset, 'N/A', p_quoted_ngn_kobo, 'pending',
          jsonb_build_object('asset', p_asset, 'crypto_micro', p_crypto_micro,
                              'quidax_swap_id', p_swap_id,
                              'quoted_ngn_kobo', p_quoted_ngn_kobo,
                              'idempotency_key', p_idempotency_key))
  RETURNING id INTO v_tx_id;

  RETURN v_tx_id;
END;
$$;

-- Sell step 2: Quidax confirmed the swap — credit the user's Naira wallet
-- with what they ACTUALLY received (never the earlier quote, which can
-- differ) and settle the transaction. Idempotent on the swap id, since
-- webhooks retry.
CREATE OR REPLACE FUNCTION public.complete_crypto_sell(
  p_swap_id  TEXT,
  p_ngn_kobo BIGINT
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tx_id   UUID;
  v_user_id UUID;
  v_status  TEXT;
BEGIN
  IF p_ngn_kobo IS NULL OR p_ngn_kobo <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT';
  END IF;

  SELECT id, user_id, status INTO v_tx_id, v_user_id, v_status
    FROM transactions
   WHERE type = 'crypto_sell' AND metadata->>'quidax_swap_id' = p_swap_id
   FOR UPDATE;

  IF v_tx_id IS NULL THEN
    RETURN NULL;
  END IF;
  -- Already settled by an earlier delivery of the same webhook.
  IF v_status <> 'pending' THEN
    RETURN v_tx_id;
  END IF;

  UPDATE wallets SET balance = balance + p_ngn_kobo, updated_at = now()
   WHERE user_id = v_user_id;

  UPDATE transactions
     SET status = 'completed',
         amount_ngn = p_ngn_kobo,
         completed_at = now(),
         metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('settled_ngn_kobo', p_ngn_kobo)
   WHERE id = v_tx_id;

  RETURN v_tx_id;
END;
$$;

-- Sell failure path: Quidax rejected/failed the swap. Nothing was debited
-- locally and the user's crypto stays in their sub-account, so this only
-- marks the record.
CREATE OR REPLACE FUNCTION public.fail_crypto_sell(
  p_swap_id TEXT,
  p_reason  TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE transactions
     SET status = 'failed',
         metadata = COALESCE(metadata, '{}'::jsonb)
                    || jsonb_build_object('failure_reason', COALESCE(p_reason, 'swap_failed'))
   WHERE type = 'crypto_sell'
     AND metadata->>'quidax_swap_id' = p_swap_id
     AND status = 'pending';
END;
$$;

-- Withdraw step 1: record the outgoing send as pending. Again no local
-- debit — Quidax deducts from the user's own sub-account balance, and the
-- balance the app displays is read live from Quidax, so debiting anything
-- here would double-count.
CREATE OR REPLACE FUNCTION public.record_crypto_withdrawal_pending(
  p_user_id      UUID,
  p_asset        TEXT,
  p_crypto_micro BIGINT,
  p_network      TEXT,
  p_address      TEXT,
  p_reference    TEXT
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tx_id UUID;
BEGIN
  IF p_crypto_micro IS NULL OR p_crypto_micro <= 0 OR p_reference IS NULL THEN
    RAISE EXCEPTION 'INVALID_WITHDRAWAL';
  END IF;

  SELECT id INTO v_tx_id FROM transactions
   WHERE metadata->>'quidax_reference' = p_reference LIMIT 1;
  IF v_tx_id IS NOT NULL THEN
    RETURN v_tx_id;
  END IF;

  INSERT INTO transactions (user_id, type, recipient_phone, network, amount_ngn, status, metadata)
  VALUES (p_user_id, 'crypto_withdraw', p_address, 'N/A', 0, 'pending',
          jsonb_build_object('asset', p_asset, 'crypto_micro', p_crypto_micro,
                              'crypto_network', p_network, 'address', p_address,
                              'quidax_reference', p_reference,
                              'idempotency_key', p_reference))
  RETURNING id INTO v_tx_id;

  RETURN v_tx_id;
END;
$$;

-- Withdraw step 2: settle from the withdraw.successful / withdraw.rejected
-- webhook. Idempotent on the reference.
CREATE OR REPLACE FUNCTION public.settle_crypto_withdrawal(
  p_reference TEXT,
  p_succeeded BOOLEAN,
  p_txid      TEXT DEFAULT NULL,
  p_reason    TEXT DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tx_id  UUID;
  v_status TEXT;
BEGIN
  SELECT id, status INTO v_tx_id, v_status
    FROM transactions
   WHERE type = 'crypto_withdraw' AND metadata->>'quidax_reference' = p_reference
   FOR UPDATE;

  IF v_tx_id IS NULL OR v_status <> 'pending' THEN
    RETURN v_tx_id;
  END IF;

  UPDATE transactions
     SET status = CASE WHEN p_succeeded THEN 'completed' ELSE 'failed' END,
         completed_at = CASE WHEN p_succeeded THEN now() ELSE completed_at END,
         metadata = COALESCE(metadata, '{}'::jsonb)
                    || jsonb_strip_nulls(jsonb_build_object('txid', p_txid, 'failure_reason', p_reason))
   WHERE id = v_tx_id;

  RETURN v_tx_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.record_crypto_sell_pending(UUID,TEXT,BIGINT,TEXT,BIGINT,TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.complete_crypto_sell(TEXT,BIGINT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fail_crypto_sell(TEXT,TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.record_crypto_withdrawal_pending(UUID,TEXT,BIGINT,TEXT,TEXT,TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.settle_crypto_withdrawal(TEXT,BOOLEAN,TEXT,TEXT) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.record_crypto_sell_pending(UUID,TEXT,BIGINT,TEXT,BIGINT,TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_crypto_sell(TEXT,BIGINT) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_crypto_sell(TEXT,TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_crypto_withdrawal_pending(UUID,TEXT,BIGINT,TEXT,TEXT,TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.settle_crypto_withdrawal(TEXT,BOOLEAN,TEXT,TEXT) TO service_role;
