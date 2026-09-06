-- VTUnaija's real transaction-query API (confirmed via its own documentation,
-- 2026-09-06) returns "processing"/"pending" as genuine in-flight states,
-- distinct from "unknown" (a response we couldn't recognize at all). This
-- function's outcome allow-list predates that confirmation and only knew
-- success/failed/unknown -- widen it so a real "still processing" answer
-- isn't rejected outright (RAISE EXCEPTION) when admin-refund tries to
-- record it as verification evidence.
CREATE OR REPLACE FUNCTION public.record_provider_refund_verification(
  p_tx_id UUID,
  p_provider TEXT,
  p_outcome TEXT,
  p_query_reference TEXT,
  p_provider_transaction_id TEXT DEFAULT NULL,
  p_message TEXT DEFAULT NULL
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_updated INTEGER := 0;
BEGIN
  IF p_outcome NOT IN ('success', 'failed', 'processing', 'unknown') THEN
    RAISE EXCEPTION 'INVALID_PROVIDER_VERIFICATION_OUTCOME';
  END IF;

  UPDATE public.transactions
  SET metadata = COALESCE(metadata, '{}'::JSONB) || jsonb_build_object(
    'refund_verification', jsonb_build_object(
      'provider', left(COALESCE(NULLIF(trim(p_provider), ''), 'unknown'), 40),
      'outcome', p_outcome,
      'query_reference', left(COALESCE(p_query_reference, ''), 120),
      'provider_transaction_id', CASE
        WHEN p_provider_transaction_id IS NULL THEN NULL
        ELSE left(p_provider_transaction_id, 120)
      END,
      'message', left(COALESCE(p_message, ''), 300),
      'verified_at', now()
    )
  )
  WHERE id = p_tx_id AND status = 'pending';

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.record_provider_refund_verification(UUID,TEXT,TEXT,TEXT,TEXT,TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_provider_refund_verification(UUID,TEXT,TEXT,TEXT,TEXT,TEXT) TO service_role;
