-- Kay's Pay Phase 6: capacity-oriented query paths and server-side summaries.
CREATE INDEX IF NOT EXISTS idx_transactions_status_created
  ON public.transactions(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_transactions_type_status_created
  ON public.transactions(type, status, created_at DESC);

CREATE OR REPLACE FUNCTION public.get_user_transaction_summary()
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'total_transactions', count(*),
    'total_spent_kobo', COALESCE(sum(amount_ngn) FILTER (
      WHERE type NOT IN ('wallet_fund', 'refund')
    ), 0)
  )
  FROM public.transactions
  WHERE user_id = (SELECT auth.uid())
$$;

REVOKE EXECUTE ON FUNCTION public.get_user_transaction_summary() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_user_transaction_summary() TO authenticated;

DO $$
BEGIN
  IF has_function_privilege('anon', 'public.get_user_transaction_summary()', 'EXECUTE') THEN
    RAISE EXCEPTION 'SECURITY_ASSERTION_FAILED: anonymous summary access';
  END IF;
END $$;
