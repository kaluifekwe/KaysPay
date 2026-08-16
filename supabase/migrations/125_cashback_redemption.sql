-- Phase 3, stage 2: redemption. Lets debit_for_service (the single shared
-- debit path used by every VTU purchase type — airtime, data, electricity,
-- TV, exam pins) apply a caller's cashback balance toward the price,
-- combined with wallet for the remainder, in one atomic update. No minimum
-- threshold — any balance above zero is usable immediately, per the owner's
-- explicit design decision. The amount actually applied is always computed
-- SERVER-SIDE from the real stored balance (LEAST of balance and price) —
-- p_use_cashback is only ever a boolean toggle, never a client-supplied
-- kobo amount, so a tampered request can't apply more cashback than
-- actually exists.
--
-- Same signature as before plus one new parameter at the end, so every
-- existing caller (which doesn't pass it) keeps working unchanged via the
-- DEFAULT FALSE. Adding a parameter changes the function's signature, and
-- CREATE OR REPLACE only replaces an EXACT signature match — without the
-- DROP below, this would silently create a second, overloaded
-- debit_for_service instead of replacing the original, leaving two
-- versions in the database and ambiguous-call errors depending on how a
-- caller invokes it. Same DROP-then-CREATE pattern migration 008 used for
-- this exact function's previous signature change.
DROP FUNCTION IF EXISTS public.debit_for_service(UUID, BIGINT, TEXT, TEXT, TEXT, JSONB, TEXT);

CREATE OR REPLACE FUNCTION public.debit_for_service(
  p_user_id          UUID,
  p_amount           BIGINT,     -- kobo
  p_type             TEXT,
  p_network          TEXT,
  p_recipient        TEXT,
  p_metadata         JSONB,
  p_idempotency_key  TEXT,
  p_use_cashback     BOOLEAN DEFAULT FALSE
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_balance          BIGINT;
  v_cashback_balance BIGINT;
  v_cashback_used    BIGINT;
  v_wallet_used      BIGINT;
  v_tx_id            UUID;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT';
  END IF;

  SELECT id INTO v_tx_id
    FROM transactions
   WHERE metadata->>'idempotency_key' = p_idempotency_key
   LIMIT 1;
  IF v_tx_id IS NOT NULL THEN
    RETURN v_tx_id;
  END IF;

  SELECT balance, cashback_balance_kobo INTO v_balance, v_cashback_balance
    FROM wallets WHERE user_id = p_user_id FOR UPDATE;
  IF v_balance IS NULL THEN
    RAISE EXCEPTION 'WALLET_NOT_FOUND';
  END IF;

  v_cashback_used := CASE WHEN p_use_cashback THEN LEAST(COALESCE(v_cashback_balance, 0), p_amount) ELSE 0 END;
  v_wallet_used := p_amount - v_cashback_used;

  IF v_balance < v_wallet_used THEN
    RAISE EXCEPTION 'INSUFFICIENT_FUNDS';
  END IF;

  UPDATE wallets SET
    balance = balance - v_wallet_used,
    cashback_balance_kobo = cashback_balance_kobo - v_cashback_used,
    updated_at = now()
  WHERE user_id = p_user_id;

  INSERT INTO transactions (user_id, type, recipient_phone, network, amount_ngn, status, metadata, cashback_used_kobo)
  VALUES (p_user_id, p_type, p_recipient, COALESCE(p_network, 'N/A'), p_amount, 'pending',
          COALESCE(p_metadata, '{}'::jsonb) || jsonb_build_object('idempotency_key', p_idempotency_key),
          v_cashback_used)
  RETURNING id INTO v_tx_id;

  IF v_cashback_used > 0 THEN
    INSERT INTO public.cashback_ledger(transaction_id, user_id, entry_type, amount_kobo, balance_after_kobo)
    VALUES (v_tx_id, p_user_id, 'redeemed', v_cashback_used, v_cashback_balance - v_cashback_used)
    ON CONFLICT (transaction_id, entry_type) DO NOTHING;
  END IF;

  RETURN v_tx_id;
END;
$$;

-- Explicit revoke from anon/authenticated, not just PUBLIC — Supabase
-- auto-grants those roles independently of PUBLIC (the exact class of gap
-- the 2026-08-06 security audit, migration 083, fixed on other functions).
-- Dropping and recreating this function is the moment to close it here too,
-- rather than carrying forward whatever the original 2026-06 grant covered.
REVOKE EXECUTE ON FUNCTION public.debit_for_service(UUID, BIGINT, TEXT, TEXT, TEXT, JSONB, TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.debit_for_service(UUID, BIGINT, TEXT, TEXT, TEXT, JSONB, TEXT, BOOLEAN) TO service_role;
