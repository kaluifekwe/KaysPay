-- Kay's Pay: refund an already-COMPLETED service transaction
-- =====================================================================
-- refund_service_transaction() only ever matches status = 'pending' (it's
-- meant for "provider rejected the pending request"). Foreign Number
-- purchases complete immediately on successful rental (the number itself
-- is the paid-for good), so a later user-initiated cancellation — when no
-- SMS code ever arrives — needs a genuine post-completion reversal, not a
-- pending-request rollback. Same locking/crediting pattern, different
-- precondition and target status.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.refund_completed_service_transaction(
  p_tx_id UUID,
  p_reason TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID;
  v_amount  NUMERIC;
BEGIN
  SELECT user_id, amount_ngn INTO v_user_id, v_amount
    FROM transactions
   WHERE id = p_tx_id AND status = 'completed'
   FOR UPDATE;

  IF v_user_id IS NULL THEN
    RETURN; -- already refunded/not found/not completed; nothing to do
  END IF;

  UPDATE wallets
     SET balance = balance + v_amount, updated_at = now()
   WHERE user_id = v_user_id;

  UPDATE transactions
     SET status = 'failed',
         metadata = COALESCE(metadata, '{}'::jsonb)
                    || jsonb_build_object('failure_reason', COALESCE(p_reason, 'user_cancelled'),
                                          'refunded', true)
   WHERE id = p_tx_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.refund_completed_service_transaction(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.refund_completed_service_transaction(UUID, TEXT) TO service_role;
