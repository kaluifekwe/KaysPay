CREATE OR REPLACE FUNCTION public.admin_financial_forecast_report(p_as_of TIMESTAMPTZ DEFAULT now()) RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
WITH providers(provider) AS (VALUES('vtunaija'::text),('airalo'),('prembly')), latest AS (
 SELECT DISTINCT ON(provider) provider,amount_kobo balance_kobo,occurred_at
 FROM provider_finance_entries WHERE entry_type='balance_snapshot' AND occurred_at<=p_as_of ORDER BY provider,occurred_at DESC,created_at DESC
), spend AS (
 SELECT lower(metadata->>'provider') provider,COALESCE(sum(provider_cost_kobo),0) spend_30d
 FROM transactions WHERE status='completed' AND provider_cost_kobo IS NOT NULL AND created_at>=p_as_of-interval '30 days' AND created_at<p_as_of GROUP BY 1
), lifetime AS (
 SELECT lower(metadata->>'provider') provider,COALESCE(sum(provider_cost_kobo),0) spend_total
 FROM transactions WHERE status='completed' AND provider_cost_kobo IS NOT NULL AND created_at<p_as_of GROUP BY 1
), funded AS (
 SELECT provider,COALESCE(sum(amount_kobo) FILTER(WHERE entry_type='wallet_funding'),0)+COALESCE(sum(amount_kobo) FILTER(WHERE entry_type='adjustment'),0) funded_total
 FROM provider_finance_entries WHERE occurred_at<p_as_of GROUP BY provider
), rows AS (
 SELECT p.provider,l.balance_kobo,l.occurred_at balance_recorded_at,COALESCE(s.spend_30d,0) spend_30d_kobo,
  round(COALESCE(s.spend_30d,0)/30.0)::bigint average_daily_spend_kobo,
  CASE WHEN COALESCE(s.spend_30d,0)>0 AND l.balance_kobo IS NOT NULL THEN round(l.balance_kobo/(s.spend_30d/30.0),1) END days_remaining,
  round(COALESCE(s.spend_30d,0)/30.0*7)::bigint requirement_7d_kobo,round(COALESCE(s.spend_30d,0)/30.0*30)::bigint requirement_30d_kobo,
  round(COALESCE(s.spend_30d,0)/30.0*7)::bigint suggested_minimum_balance_kobo,
  CASE WHEN l.balance_kobo IS NULL THEN NULL ELSE COALESCE(f.funded_total,0)-COALESCE(t.spend_total,0)-l.balance_kobo END unreconciled_kobo
 FROM providers p LEFT JOIN latest l USING(provider) LEFT JOIN spend s USING(provider) LEFT JOIN lifetime t USING(provider) LEFT JOIN funded f USING(provider)
)
SELECT jsonb_build_object('as_of',p_as_of,'providers',COALESCE(jsonb_agg(to_jsonb(rows) ORDER BY provider),'[]'::jsonb),
 'providers_low_runway',count(*) FILTER(WHERE days_remaining IS NOT NULL AND days_remaining<=3),
 'providers_missing_snapshot',count(*) FILTER(WHERE balance_kobo IS NULL)) FROM rows;
$$;
REVOKE EXECUTE ON FUNCTION public.admin_financial_forecast_report(TIMESTAMPTZ) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.admin_financial_forecast_report(TIMESTAMPTZ) TO service_role;

DO $$ BEGIN PERFORM cron.unschedule('financial-forecast-monitor');EXCEPTION WHEN OTHERS THEN NULL;END $$;
SELECT cron.schedule('financial-forecast-monitor','15 */6 * * *',$$
 SELECT net.http_post(
  url:='https://xswlrzhtxrzugoxdonjc.supabase.co/functions/v1/financial-forecast-monitor',
  headers:=jsonb_build_object('Content-Type','application/json','x-cron-secret',(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='cron_secret')),
  body:='{}'::jsonb,timeout_milliseconds:=30000
 );
$$);

