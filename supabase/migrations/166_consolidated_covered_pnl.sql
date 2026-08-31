CREATE OR REPLACE FUNCTION public.admin_consolidated_pnl_report(p_start TIMESTAMPTZ,p_end TIMESTAMPTZ) RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
WITH bounds AS (SELECT p_end-p_start span), service AS (
 SELECT COALESCE(sum(net_profit_after_cashback_kobo),0) earnings,
  count(*) FILTER(WHERE provider_cost_kobo IS NOT NULL) covered,count(*) completed
 FROM transactions WHERE status='completed' AND type NOT IN('crypto_buy','crypto_sell','wallet_fund','refund','withdrawal','card_fund','payroll') AND created_at>=p_start AND created_at<p_end
), crypto AS (
 SELECT COALESCE(sum(CASE WHEN type='crypto_buy' AND metadata->>'merchant_markup_ngn' ~ '^\d+(\.\d+)?$' THEN round((metadata->>'merchant_markup_ngn')::numeric*100)::bigint
                          WHEN type='crypto_sell' AND metadata->>'merchant_markup_kobo' ~ '^\d+$' THEN (metadata->>'merchant_markup_kobo')::bigint END),0) earnings,
  count(*) FILTER(WHERE (type='crypto_buy' AND metadata->>'merchant_markup_ngn' ~ '^\d+(\.\d+)?$') OR (type='crypto_sell' AND metadata->>'merchant_markup_kobo' ~ '^\d+$')) covered,
  count(*) completed
 FROM transactions WHERE status='completed' AND type IN('crypto_buy','crypto_sell') AND created_at>=p_start AND created_at<p_end
), expenses AS (
 SELECT COALESCE(sum(amount_kobo) FILTER(WHERE entry_type='funding_fee'),0) funding_fees,
  COALESCE(sum(amount_kobo) FILTER(WHERE entry_type='operating_expense'),0) operating_expenses
 FROM provider_finance_entries WHERE occurred_at>=p_start AND occurred_at<p_end
), prior_service AS (
 SELECT COALESCE(sum(net_profit_after_cashback_kobo),0) earnings FROM transactions,bounds WHERE status='completed' AND created_at>=p_start-span AND created_at<p_start
), prior_crypto AS (
 SELECT COALESCE(sum(CASE WHEN type='crypto_buy' AND metadata->>'merchant_markup_ngn' ~ '^\d+(\.\d+)?$' THEN round((metadata->>'merchant_markup_ngn')::numeric*100)::bigint
                          WHEN type='crypto_sell' AND metadata->>'merchant_markup_kobo' ~ '^\d+$' THEN (metadata->>'merchant_markup_kobo')::bigint END),0) earnings
 FROM transactions,bounds WHERE status='completed' AND type IN('crypto_buy','crypto_sell') AND created_at>=p_start-span AND created_at<p_start
), prior_expenses AS (
 SELECT COALESCE(sum(amount_kobo) FILTER(WHERE entry_type IN('funding_fee','operating_expense')),0) total
 FROM provider_finance_entries,bounds WHERE occurred_at>=p_start-span AND occurred_at<p_start
), source_rows AS (
 SELECT COALESCE(NULLIF(lower(metadata->>'provider'),''),cost_source,'other_services') source,
  count(*) covered_transactions,COALESCE(sum(net_profit_after_cashback_kobo),0) earnings_kobo
 FROM transactions WHERE status='completed' AND created_at>=p_start AND created_at<p_end AND provider_cost_kobo IS NOT NULL GROUP BY 1
 UNION ALL SELECT 'crypto_markup',count(*) FILTER(WHERE status='completed' AND ((type='crypto_buy' AND metadata->>'merchant_markup_ngn' ~ '^\d+(\.\d+)?$') OR (type='crypto_sell' AND metadata->>'merchant_markup_kobo' ~ '^\d+$'))),COALESCE(sum(CASE WHEN type='crypto_buy' AND metadata->>'merchant_markup_ngn' ~ '^\d+(\.\d+)?$' THEN round((metadata->>'merchant_markup_ngn')::numeric*100)::bigint
 WHEN type='crypto_sell' AND metadata->>'merchant_markup_kobo' ~ '^\d+$' THEN (metadata->>'merchant_markup_kobo')::bigint END),0)
 FROM transactions WHERE status='completed' AND type IN('crypto_buy','crypto_sell') AND created_at>=p_start AND created_at<p_end
), daily AS (
 SELECT d::date AS bucket_day,
  COALESCE((SELECT sum(net_profit_after_cashback_kobo) FROM transactions WHERE status='completed' AND provider_cost_kobo IS NOT NULL AND created_at>=d AND created_at<d+interval '1 day'),0) service_earnings_kobo,
  COALESCE((SELECT sum(CASE WHEN type='crypto_buy' AND metadata->>'merchant_markup_ngn' ~ '^\d+(\.\d+)?$' THEN round((metadata->>'merchant_markup_ngn')::numeric*100)::bigint WHEN type='crypto_sell' AND metadata->>'merchant_markup_kobo' ~ '^\d+$' THEN (metadata->>'merchant_markup_kobo')::bigint END) FROM transactions WHERE status='completed' AND type IN('crypto_buy','crypto_sell') AND created_at>=d AND created_at<d+interval '1 day'),0) crypto_markup_kobo,
  COALESCE((SELECT sum(amount_kobo) FROM provider_finance_entries WHERE entry_type IN('funding_fee','operating_expense') AND occurred_at>=d AND occurred_at<d+interval '1 day'),0) expenses_kobo
 FROM generate_series(date_trunc('day',p_start),date_trunc('day',p_end-interval '1 microsecond'),interval '1 day') d
)
SELECT jsonb_build_object(
 'service_earnings_kobo',s.earnings,'crypto_markup_kobo',c.earnings,'total_covered_earnings_kobo',s.earnings+c.earnings,
 'funding_fees_kobo',e.funding_fees,'operating_expenses_kobo',e.operating_expenses,
 'net_operating_profit_kobo',s.earnings+c.earnings-e.funding_fees-e.operating_expenses,
 'service_cost_coverage_percent',COALESCE(round(100.0*s.covered/nullif(s.completed,0),2),0),
 'crypto_markup_coverage_percent',COALESCE(round(100.0*c.covered/nullif(c.completed,0),2),0),
 'prior_net_operating_profit_kobo',ps.earnings+pc.earnings-pe.total,
 'sources',COALESCE((SELECT jsonb_agg(to_jsonb(source_rows) ORDER BY earnings_kobo DESC) FROM source_rows),'[]'::jsonb),
 'daily',COALESCE((SELECT jsonb_agg(jsonb_build_object('day',bucket_day,'service_earnings_kobo',service_earnings_kobo,'crypto_markup_kobo',crypto_markup_kobo,'expenses_kobo',expenses_kobo,'net_kobo',service_earnings_kobo+crypto_markup_kobo-expenses_kobo) ORDER BY bucket_day) FROM daily),'[]'::jsonb)
) FROM service s CROSS JOIN crypto c CROSS JOIN expenses e CROSS JOIN prior_service ps CROSS JOIN prior_crypto pc CROSS JOIN prior_expenses pe;
$$;
REVOKE EXECUTE ON FUNCTION public.admin_consolidated_pnl_report(TIMESTAMPTZ,TIMESTAMPTZ) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.admin_consolidated_pnl_report(TIMESTAMPTZ,TIMESTAMPTZ) TO service_role;
