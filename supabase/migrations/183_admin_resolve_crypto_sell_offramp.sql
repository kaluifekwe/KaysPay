-- Recovery path for a stuck off-ramp Sell (status='failed', failure_reason=
-- 'offramp_failed'). Real incident: crypto already left the customer's own
-- Quidax sub-account before the NGN payout failed, so there is nothing
-- locally to reverse -- complete_crypto_sell_offramp/fail_crypto_sell_offramp
-- (migration 139) only ever transition a 'pending' row, so a late webhook
-- from Quidax retrying the payout would be silently ignored once the row is
-- already 'failed'. Previously this just sat as an open critical alert with
-- no way to close it out. This is deliberately an admin-driven, manual
-- action -- there is no way to safely automate "did Quidax actually pay the
-- bank or return the crypto" without asking Quidax directly.
--
-- Three outcomes an admin can record, based on what Quidax confirms:
--   'ngn_paid_by_quidax'  -- Quidax completed the bank payout outside our
--                            webhook. Mirrors what complete_crypto_sell_offramp
--                            would have done: status -> completed, real
--                            confirmed amount recorded. Requires p_settled_ngn_kobo.
--   'crypto_returned'     -- Quidax put the USDT back in the customer's own
--                            sub-account. No local balance to touch -- Sell's
--                            balance is always read live from Quidax, so the
--                            wallet already reflects this the moment Quidax
--                            does it. This just records the outcome and
--                            closes the alert.
--   'writeoff'            -- Confirmed unrecoverable. Stays 'failed', flagged
--                            for accounting visibility.
CREATE OR REPLACE FUNCTION public.admin_resolve_crypto_sell_offramp(
  p_admin_user_id UUID,
  p_transaction_id UUID,
  p_resolution TEXT,
  p_notes TEXT,
  p_settled_ngn_kobo BIGINT DEFAULT NULL
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_status TEXT;
  v_type TEXT;
  v_fingerprint TEXT;
BEGIN
  IF p_resolution NOT IN ('ngn_paid_by_quidax', 'crypto_returned', 'writeoff') THEN
    RAISE EXCEPTION 'INVALID_RESOLUTION';
  END IF;
  IF length(trim(COALESCE(p_notes, ''))) < 3 THEN
    RAISE EXCEPTION 'NOTES_REQUIRED';
  END IF;
  IF p_resolution = 'ngn_paid_by_quidax' AND (p_settled_ngn_kobo IS NULL OR p_settled_ngn_kobo <= 0) THEN
    RAISE EXCEPTION 'SETTLED_AMOUNT_REQUIRED';
  END IF;

  SELECT status, type INTO v_status, v_type FROM transactions WHERE id = p_transaction_id FOR UPDATE;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'TRANSACTION_NOT_FOUND';
  END IF;
  IF v_type <> 'crypto_sell' THEN
    RAISE EXCEPTION 'NOT_A_CRYPTO_SELL';
  END IF;
  IF v_status <> 'failed' THEN
    RAISE EXCEPTION 'NOT_IN_FAILED_STATE';
  END IF;

  IF p_resolution = 'ngn_paid_by_quidax' THEN
    UPDATE transactions SET
      status = 'completed',
      amount_ngn = p_settled_ngn_kobo,
      completed_at = now(),
      metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
        'settled_ngn_kobo', p_settled_ngn_kobo,
        'resolved_manually', true, 'resolution', p_resolution,
        'resolution_notes', p_notes, 'resolved_by', p_admin_user_id, 'resolved_at', now()
      )
    WHERE id = p_transaction_id;
  ELSE
    UPDATE transactions SET
      metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
        'resolved_manually', true, 'resolution', p_resolution,
        'resolution_notes', p_notes, 'resolved_by', p_admin_user_id, 'resolved_at', now()
      )
    WHERE id = p_transaction_id;
  END IF;

  v_fingerprint := 'crypto_sell_offramp_failed_' || p_transaction_id::text;
  UPDATE monitoring_alerts SET
    status = 'resolved', resolved_at = now(), resolved_by = p_admin_user_id,
    resolution_notes = p_notes, updated_at = now()
  WHERE fingerprint = v_fingerprint AND status <> 'resolved';

  RETURN jsonb_build_object('transaction_id', p_transaction_id, 'resolution', p_resolution);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.admin_resolve_crypto_sell_offramp(UUID, UUID, TEXT, TEXT, BIGINT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_resolve_crypto_sell_offramp(UUID, UUID, TEXT, TEXT, BIGINT) TO service_role;

-- Listing helper for the admin UI: every crypto_sell currently stuck failed,
-- newest first, joined to its still-open alert if one exists.
CREATE OR REPLACE FUNCTION public.admin_list_stuck_crypto_sells()
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'transaction_id', t.id,
    'user_id', t.user_id,
    'crypto_micro', t.metadata->'crypto_micro',
    'asset', t.metadata->>'asset',
    'quidax_reference', t.metadata->>'quidax_reference',
    'quidax_merchant_reference', t.metadata->>'quidax_merchant_reference',
    'failure_reason', t.metadata->>'failure_reason',
    'created_at', t.created_at,
    'alert_status', a.status
  ) ORDER BY t.created_at DESC), '[]'::jsonb)
  FROM transactions t
  LEFT JOIN monitoring_alerts a ON a.fingerprint = 'crypto_sell_offramp_failed_' || t.id::text
  WHERE t.type = 'crypto_sell' AND t.status = 'failed'
    AND (t.metadata->>'resolved_manually') IS DISTINCT FROM 'true'
$$;
REVOKE EXECUTE ON FUNCTION public.admin_list_stuck_crypto_sells() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_list_stuck_crypto_sells() TO service_role;
