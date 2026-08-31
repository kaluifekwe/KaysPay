CREATE OR REPLACE FUNCTION public.admin_business_intelligence_report(p_start TIMESTAMPTZ,p_end TIMESTAMPTZ)
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
WITH bounds AS (
  SELECT p_start start_at,p_end end_at,p_start-(p_end-p_start) prior_start,p_start prior_end
), scoped AS (
  SELECT t.*,CASE WHEN t.type IN ('airtime','data','bill','exam_pin','esim','foreign_number','nin_verification','nin_validation','bvn_verification','nin_name_modification','nin_phone_modification','nin_address_modification','crypto_buy') THEN true ELSE false END is_service_sale
  FROM public.transactions t,bounds b WHERE t.created_at>=b.start_at AND t.created_at<b.end_at
), prior AS (
  SELECT t.* FROM public.transactions t,bounds b WHERE t.created_at>=b.prior_start AND t.created_at<b.prior_end
), days AS (
  SELECT d::date AS report_day FROM bounds b,generate_series(date_trunc('day',b.start_at),date_trunc('day',b.end_at-interval '1 millisecond'),interval '1 day') d
), daily AS (
  SELECT d.report_day,count(s.id) orders,count(s.id) FILTER(WHERE s.status='completed') completed,
    COALESCE(sum(s.amount_ngn) FILTER(WHERE s.status='completed' AND s.is_service_sale),0) service_volume_kobo
  FROM days d LEFT JOIN scoped s ON s.created_at>=d.report_day AND s.created_at<d.report_day+1 GROUP BY d.report_day ORDER BY d.report_day
), services AS (
  SELECT type,count(*) orders,count(*) FILTER(WHERE status='completed') completed,
    count(*) FILTER(WHERE status='failed' AND COALESCE(metadata->>'refunded','')<>'true') failed,
    count(*) FILTER(WHERE status='failed' AND metadata->>'refunded'='true') refunded,
    COALESCE(sum(amount_ngn) FILTER(WHERE status='completed'),0) volume_kobo
  FROM scoped GROUP BY type
)
SELECT jsonb_build_object(
 'generated_at',now(),'start_at',p_start,'end_at',p_end,'currency','NGN','margin_data_available',false,
 'summary',jsonb_build_object(
   'orders',count(*),'completed',count(*) FILTER(WHERE status='completed'),
   'failed',count(*) FILTER(WHERE status='failed' AND COALESCE(metadata->>'refunded','')<>'true'),
   'refunded',count(*) FILTER(WHERE status='failed' AND metadata->>'refunded'='true'),
   'service_sales_volume_kobo',COALESCE(sum(amount_ngn) FILTER(WHERE status='completed' AND is_service_sale),0),
   'all_completed_volume_kobo',COALESCE(sum(amount_ngn) FILTER(WHERE status='completed'),0),
   'average_service_order_kobo',COALESCE(round(avg(amount_ngn) FILTER(WHERE status='completed' AND is_service_sale)),0),
   'success_rate',COALESCE(round(100.0*count(*) FILTER(WHERE status='completed')/nullif(count(*),0),2),0)
 ),
 'comparison',(SELECT jsonb_build_object(
   'prior_orders',count(*),'prior_completed',count(*) FILTER(WHERE status='completed'),
   'prior_service_sales_volume_kobo',COALESCE(sum(amount_ngn) FILTER(WHERE status='completed' AND type IN ('airtime','data','bill','exam_pin','esim','foreign_number','nin_verification','nin_validation','bvn_verification','nin_name_modification','nin_phone_modification','nin_address_modification','crypto_buy')),0)
 ) FROM prior),
 'services',(SELECT COALESCE(jsonb_agg(to_jsonb(services) ORDER BY volume_kobo DESC),'[]'::jsonb) FROM services),
 'daily',(SELECT COALESCE(jsonb_agg(jsonb_build_object('day',report_day,'orders',orders,'completed',completed,'service_volume_kobo',service_volume_kobo) ORDER BY report_day),'[]'::jsonb) FROM daily)
)
FROM scoped;
$$;
REVOKE EXECUTE ON FUNCTION public.admin_business_intelligence_report(TIMESTAMPTZ,TIMESTAMPTZ) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.admin_business_intelligence_report(TIMESTAMPTZ,TIMESTAMPTZ) TO service_role;
