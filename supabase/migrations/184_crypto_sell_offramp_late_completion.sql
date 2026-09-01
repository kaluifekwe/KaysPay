-- Owner request after today's incident: when Quidax later confirms a sale
-- that we'd already marked 'failed' (offramp_failed), the app should pick
-- that up on its own -- not require an admin to manually resolve it every
-- time via migration 183's tool.
--
-- Two gaps closed together:
-- 1. complete_crypto_sell_offramp (migration 165) only ever transitioned a
--    'pending' row. The webhook (crypto-ramp-webhook, sell_transaction.
--    successful) already calls this RPC unconditionally regardless of
--    current status -- it was purely this function's own guard silently
--    no-op'ing a late success signal for anything already 'failed'.
-- 2. crypto-sell-reconcile only ever swept 'pending' rows, so even without
--    a webhook a 'failed' sale could never self-heal via the existing
--    periodic requery either (see the companion edge function change).
--
-- Manually-resolved transactions (migration 183's admin tool, marked
-- metadata.resolved_manually = true) are explicitly excluded from both
-- paths -- an admin's deliberate "crypto returned" or "write off" call
-- must never be silently overwritten by a later, possibly-stale signal.
--
-- Everything else here (metadata keys, jsonb_strip_nulls, validation) is
-- unchanged from migration 165 -- admin_markup_commission_report and other
-- reporting reads these exact keys (merchant_markup_kobo, not _ngn).
CREATE OR REPLACE FUNCTION public.complete_crypto_sell_offramp(
  p_reference TEXT,p_ngn_kobo BIGINT,p_markup_kobo BIGINT DEFAULT NULL,
  p_processor_fee_kobo BIGINT DEFAULT NULL,p_vat_kobo BIGINT DEFAULT NULL
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_tx_id UUID;v_status TEXT;v_resolved_manually TEXT;
BEGIN
 IF p_ngn_kobo IS NULL OR p_ngn_kobo<=0 OR p_markup_kobo<0 OR p_processor_fee_kobo<0 OR p_vat_kobo<0 THEN RAISE EXCEPTION 'INVALID_AMOUNT';END IF;
 SELECT id,status,metadata->>'resolved_manually' INTO v_tx_id,v_status,v_resolved_manually
   FROM transactions WHERE type='crypto_sell' AND (metadata->>'quidax_reference'=p_reference OR metadata->>'quidax_merchant_reference'=p_reference) FOR UPDATE;
 IF v_tx_id IS NULL THEN RETURN NULL;END IF;
 IF v_status NOT IN ('pending','failed') OR v_resolved_manually='true' THEN RETURN v_tx_id;END IF;

 UPDATE transactions SET status='completed',amount_ngn=p_ngn_kobo,completed_at=now(),metadata=COALESCE(metadata,'{}')||jsonb_strip_nulls(jsonb_build_object(
   'settled_ngn_kobo',p_ngn_kobo,'merchant_markup_kobo',p_markup_kobo,'processor_fee_kobo',p_processor_fee_kobo,'vat_kobo',p_vat_kobo,'financials_captured_at',now()
 )) WHERE id=v_tx_id;

 -- A row that was previously 'failed' has an open critical alert
 -- (migration 139's fail_crypto_sell_offramp) that now needs closing --
 -- the late success means there's nothing left to manually follow up on.
 IF v_status='failed' THEN
   UPDATE monitoring_alerts SET status='resolved',resolved_at=now(),
     resolution_notes='Auto-resolved: Quidax later confirmed the payout succeeded.'
   WHERE fingerprint='crypto_sell_offramp_failed_'||v_tx_id::text AND status<>'resolved';
 END IF;

 RETURN v_tx_id;
END;$$;
REVOKE EXECUTE ON FUNCTION public.complete_crypto_sell_offramp(TEXT,BIGINT,BIGINT,BIGINT,BIGINT) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.complete_crypto_sell_offramp(TEXT,BIGINT,BIGINT,BIGINT,BIGINT) TO service_role;
