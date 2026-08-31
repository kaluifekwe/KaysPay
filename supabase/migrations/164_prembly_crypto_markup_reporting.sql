ALTER TABLE public.provider_finance_entries DROP CONSTRAINT IF EXISTS provider_finance_entries_service_provider_check;
ALTER TABLE public.provider_finance_entries
  ADD CONSTRAINT provider_finance_entries_service_provider_check
  CHECK(provider IN ('vtunaija','airalo','prembly')) NOT VALID;

CREATE OR REPLACE FUNCTION public.admin_markup_commission_report(p_start TIMESTAMPTZ,p_end TIMESTAMPTZ) RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
WITH crypto AS (
 SELECT type,status,amount_ngn,
  CASE WHEN type='crypto_buy' AND status='completed' AND metadata->>'merchant_markup_ngn' ~ '^\d+(\.\d+)?$'
       THEN round((metadata->>'merchant_markup_ngn')::numeric*100)::bigint END markup_kobo
 FROM transactions WHERE type IN('crypto_buy','crypto_sell') AND created_at>=p_start AND created_at<p_end
), by_type AS (
 SELECT type,count(*) attempts,count(*) FILTER(WHERE status='completed') successful,
  count(*) FILTER(WHERE status='completed' AND markup_kobo IS NOT NULL) markup_covered,
  COALESCE(sum(amount_ngn) FILTER(WHERE status='completed'),0) successful_volume_kobo,
  COALESCE(sum(markup_kobo),0) markup_revenue_kobo
 FROM crypto GROUP BY type
)
SELECT jsonb_build_object(
 'attempts',count(*),'successful',count(*) FILTER(WHERE status='completed'),
 'markup_covered',count(*) FILTER(WHERE status='completed' AND markup_kobo IS NOT NULL),
 'markup_coverage_percent',COALESCE(round(100.0*count(*) FILTER(WHERE status='completed' AND markup_kobo IS NOT NULL)/nullif(count(*) FILTER(WHERE status='completed'),0),2),0),
 'successful_volume_kobo',COALESCE(sum(amount_ngn) FILTER(WHERE status='completed'),0),
 'markup_revenue_kobo',COALESCE(sum(markup_kobo),0),
 'services',COALESCE((SELECT jsonb_agg(to_jsonb(by_type) ORDER BY type) FROM by_type),'[]'::jsonb)
) FROM crypto;
$$;
REVOKE EXECUTE ON FUNCTION public.admin_markup_commission_report(TIMESTAMPTZ,TIMESTAMPTZ) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.admin_markup_commission_report(TIMESTAMPTZ,TIMESTAMPTZ) TO service_role;

