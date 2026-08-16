-- Phase 3, stage 1 of the cashback system: schema + crediting only. No
-- redemption yet (stage 2) and no refund splitting yet (stage 3) — those
-- land as their own separate, reviewed steps once this stage is live and
-- proven, same discipline as the markup engine (migrations 122/123) that
-- computes the amount being credited here.

ALTER TABLE public.wallets
  ADD COLUMN IF NOT EXISTS cashback_balance_kobo BIGINT NOT NULL DEFAULT 0
    CHECK (cashback_balance_kobo >= 0);

-- How much of THIS specific purchase was paid using cashback rather than
-- wallet balance. Always 0 until stage 2 (redemption) exists — added now so
-- credit_cashback's anti-compounding guard below is correct from day one,
-- and so stage 3's refund splitting has this recorded on every transaction
-- going forward rather than needing a backfill later.
ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS cashback_used_kobo BIGINT NOT NULL DEFAULT 0
    CHECK (cashback_used_kobo >= 0);

-- Append-only audit trail for every cashback balance change — same
-- discipline as service_refunds (migration 094) for wallet reversals.
-- entry_type is 'earned' for now; 'redeemed' and 'refunded' are reserved
-- for stages 2 and 3.
CREATE TABLE public.cashback_ledger (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id     UUID NOT NULL REFERENCES public.transactions(id),
  user_id            UUID NOT NULL REFERENCES auth.users(id),
  entry_type         TEXT NOT NULL CHECK (entry_type IN ('earned', 'redeemed', 'refunded')),
  amount_kobo        BIGINT NOT NULL CHECK (amount_kobo > 0),
  balance_after_kobo BIGINT NOT NULL CHECK (balance_after_kobo >= 0),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The real idempotency guarantee: at most one 'earned' entry (and later,
  -- one 'redeemed'/'refunded' entry) can ever exist per transaction, so a
  -- retried or duplicated crediting attempt is a safe no-op rather than a
  -- double-credit.
  UNIQUE (transaction_id, entry_type)
);
ALTER TABLE public.cashback_ledger ENABLE ROW LEVEL SECURITY;
CREATE POLICY cashback_ledger_own_select ON public.cashback_ledger
  FOR SELECT USING (auth.uid() = user_id);
REVOKE INSERT, UPDATE, DELETE ON public.cashback_ledger FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.cashback_ledger TO authenticated;
GRANT ALL ON public.cashback_ledger TO service_role;

-- Credits a completed transaction's earned cashback exactly once. Called
-- from vtu-purchase right after complete_service_transaction succeeds, with
-- the amount already computed server-side by the markup engine
-- (computed_cashback_kobo) — never a client-supplied amount.
CREATE OR REPLACE FUNCTION public.credit_cashback(
  p_tx_id UUID,
  p_amount_kobo BIGINT
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user_id UUID;
  v_cashback_used BIGINT;
  v_new_balance BIGINT;
BEGIN
  IF p_amount_kobo IS NULL OR p_amount_kobo <= 0 THEN RETURN FALSE; END IF;

  SELECT user_id, cashback_used_kobo INTO v_user_id, v_cashback_used
  FROM public.transactions WHERE id = p_tx_id AND status = 'completed';
  IF v_user_id IS NULL THEN RETURN FALSE; END IF;

  -- Anti-compounding guard: a purchase paid for (even partly) using
  -- cashback never earns more cashback on itself. In stage 1 this is
  -- always false (nothing can be redeemed yet), but the check is correct
  -- from day one rather than needing to remember to add it in stage 2.
  IF v_cashback_used > 0 THEN RETURN FALSE; END IF;

  UPDATE public.wallets SET cashback_balance_kobo = cashback_balance_kobo + p_amount_kobo, updated_at = now()
  WHERE user_id = v_user_id
  RETURNING cashback_balance_kobo INTO v_new_balance;
  IF v_new_balance IS NULL THEN RETURN FALSE; END IF;

  INSERT INTO public.cashback_ledger(transaction_id, user_id, entry_type, amount_kobo, balance_after_kobo)
  VALUES (p_tx_id, v_user_id, 'earned', p_amount_kobo, v_new_balance)
  ON CONFLICT (transaction_id, entry_type) DO NOTHING;
  IF NOT FOUND THEN
    -- Already credited by an earlier attempt — undo this attempt's wallet
    -- bump so the ledger stays the single source of truth for what's
    -- actually been credited.
    UPDATE public.wallets SET cashback_balance_kobo = cashback_balance_kobo - p_amount_kobo, updated_at = now()
    WHERE user_id = v_user_id;
    RETURN FALSE;
  END IF;

  RETURN TRUE;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.credit_cashback(UUID, BIGINT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.credit_cashback(UUID, BIGINT) TO service_role;
