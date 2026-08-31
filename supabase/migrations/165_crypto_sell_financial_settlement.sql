DROP FUNCTION IF EXISTS public.complete_crypto_sell_offramp(TEXT,BIGINT);
CREATE OR REPLACE FUNCTION public.complete_crypto_sell_offramp(
  p_reference TEXT,p_ngn_kobo BIGINT,p_markup_kobo BIGINT DEFAULT NULL,
  p_processor_fee_kobo BIGINT DEFAULT NULL,p_vat_kobo BIGINT DEFAULT NULL
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_tx_id UUID;v_status TEXT;
BEGIN
 IF p_ngn_kobo IS NULL OR p_ngn_kobo<=0 OR p_markup_kobo<0 OR p_processor_fee_kobo<0 OR p_vat_kobo<0 THEN RAISE EXCEPTION 'INVALID_AMOUNT';END IF;
 SELECT id,status INTO v_tx_id,v_status FROM transactions WHERE type='crypto_sell' AND (metadata->>'quidax_reference'=p_reference OR metadata->>'quidax_merchant_reference'=p_reference) FOR UPDATE;
 IF v_tx_id IS NULL THEN RETURN NULL;END IF;
 IF v_status<>'pending' THEN RETURN v_tx_id;END IF;
 UPDATE transactions SET status='completed',amount_ngn=p_ngn_kobo,completed_at=now(),metadata=COALESCE(metadata,'{}')||jsonb_strip_nulls(jsonb_build_object(
   'settled_ngn_kobo',p_ngn_kobo,'merchant_markup_kobo',p_markup_kobo,'processor_fee_kobo',p_processor_fee_kobo,'vat_kobo',p_vat_kobo,'financials_captured_at',now()
 )) WHERE id=v_tx_id;
 RETURN v_tx_id;
END;$$;
REVOKE EXECUTE ON FUNCTION public.complete_crypto_sell_offramp(TEXT,BIGINT,BIGINT,BIGINT,BIGINT) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.complete_crypto_sell_offramp(TEXT,BIGINT,BIGINT,BIGINT,BIGINT) TO service_role;

CREATE OR REPLACE FUNCTION public.admin_markup_commission_report(p_start TIMESTAMPTZ,p_end TIMESTAMPTZ) RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
WITH crypto AS (
 SELECT type,status,amount_ngn,
  CASE WHEN type='crypto_buy' AND status='completed' AND metadata->>'merchant_markup_ngn' ~ '^\d+(\.\d+)?$' THEN round((metadata->>'merchant_markup_ngn')::numeric*100)::bigint
       WHEN type='crypto_sell' AND status='completed' AND metadata->>'merchant_markup_kobo' ~ '^\d+$' THEN (metadata->>'merchant_markup_kobo')::bigint END markup_kobo,
  CASE WHEN type='crypto_buy' AND metadata->>'processor_fee_ngn' ~ '^\d+(\.\d+)?$' THEN round((metadata->>'processor_fee_ngn')::numeric*100)::bigint
       WHEN type='crypto_sell' AND metadata->>'processor_fee_kobo' ~ '^\d+$' THEN (metadata->>'processor_fee_kobo')::bigint END processor_fee_kobo,
  CASE WHEN type='crypto_buy' AND metadata->>'vat_ngn' ~ '^\d+(\.\d+)?$' THEN round((metadata->>'vat_ngn')::numeric*100)::bigint
       WHEN type='crypto_sell' AND metadata->>'vat_kobo' ~ '^\d+$' THEN (metadata->>'vat_kobo')::bigint END vat_kobo
 FROM transactions WHERE type IN('crypto_buy','crypto_sell') AND created_at>=p_start AND created_at<p_end
), by_type AS (
 SELECT type,count(*) attempts,count(*) FILTER(WHERE status='completed') successful,count(*) FILTER(WHERE status='completed' AND markup_kobo IS NOT NULL) markup_covered,
  COALESCE(sum(amount_ngn) FILTER(WHERE status='completed'),0) successful_volume_kobo,COALESCE(sum(markup_kobo),0) markup_revenue_kobo,
  COALESCE(sum(processor_fee_kobo) FILTER(WHERE status='completed'),0) processor_fees_kobo,COALESCE(sum(vat_kobo) FILTER(WHERE status='completed'),0) vat_kobo
 FROM crypto GROUP BY type)
SELECT jsonb_build_object('attempts',count(*),'successful',count(*) FILTER(WHERE status='completed'),'markup_covered',count(*) FILTER(WHERE status='completed' AND markup_kobo IS NOT NULL),
 'markup_coverage_percent',COALESCE(round(100.0*count(*) FILTER(WHERE status='completed' AND markup_kobo IS NOT NULL)/nullif(count(*) FILTER(WHERE status='completed'),0),2),0),
 'successful_volume_kobo',COALESCE(sum(amount_ngn) FILTER(WHERE status='completed'),0),'markup_revenue_kobo',COALESCE(sum(markup_kobo),0),
 'processor_fees_kobo',COALESCE(sum(processor_fee_kobo) FILTER(WHERE status='completed'),0),'vat_kobo',COALESCE(sum(vat_kobo) FILTER(WHERE status='completed'),0),
 'services',COALESCE((SELECT jsonb_agg(to_jsonb(by_type) ORDER BY type) FROM by_type),'[]'::jsonb)) FROM crypto;
$$;
REVOKE EXECUTE ON FUNCTION public.admin_markup_commission_report(TIMESTAMPTZ,TIMESTAMPTZ) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.admin_markup_commission_report(TIMESTAMPTZ,TIMESTAMPTZ) TO service_role;

