-- Read-only "was this provider payment already credited?" test.
--
-- credit_wallet_funding already answers this, but only as a side effect of
-- attempting the credit, and it is reached ONLY after the KYC gate in
-- funding-credit.ts. That ordering meant re-processing an already-settled
-- payment belonging to an unverified user routed it into a fresh compliance
-- hold instead of recognising it as a duplicate: the money was long since in
-- the customer's wallet, yet they were told "complete identity verification
-- before it can be added to your wallet", and an operator got a hold to work
-- that represented nothing owed.
--
-- Observed live on 2026-08-31: restoring the funding sweep re-read two
-- Flutterwave payments from 26 and 28 Aug (600 and 1,000 naira, both credited
-- at the time) and created phantom holds for both.
--
-- No wallet was debited and releasing such a hold is harmless (it re-enters
-- credit_wallet_funding, which returns credited=false), so this is about
-- telling customers and operators the truth, not about protecting a balance.
--
-- The duplicate condition below is a deliberate mirror of the one inside
-- credit_wallet_funding (migration 101): a scoped "provider:reference" row in
-- processed_payments, or a legacy unscoped row backed by a matching
-- wallet_fund transaction. If that function's rule ever changes, change it
-- here too — they must agree, or the gate reopens.
CREATE OR REPLACE FUNCTION public.funding_already_credited(
  p_user_id UUID,
  p_reference TEXT,
  p_amount BIGINT,
  p_source TEXT
) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.processed_payments
     WHERE reference = p_source || ':' || trim(p_reference)
  ) OR EXISTS (
    SELECT 1 FROM public.processed_payments pp
     WHERE pp.reference = trim(p_reference)
       AND pp.user_id = p_user_id
       AND pp.amount_ngn = p_amount
       AND EXISTS (
         SELECT 1 FROM public.transactions t
          WHERE t.user_id = p_user_id AND t.type = 'wallet_fund'
            AND t.amount_ngn = p_amount
            AND t.metadata->>'source' = p_source
            AND t.metadata->>'reference' = trim(p_reference)
       )
  );
$$;

-- Server-side callers only. This reveals whether a given provider reference
-- has been settled, which is not a client's business.
REVOKE EXECUTE ON FUNCTION public.funding_already_credited(UUID, TEXT, BIGINT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.funding_already_credited(UUID, TEXT, BIGINT, TEXT) TO service_role;
