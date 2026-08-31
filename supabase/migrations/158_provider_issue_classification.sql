-- Separate customer/input rejections from genuine provider availability failures.
ALTER TABLE public.provider_call_events DROP CONSTRAINT IF EXISTS provider_call_events_outcome_check;
ALTER TABLE public.provider_call_events ADD CONSTRAINT provider_call_events_outcome_check
  CHECK(outcome IN ('success','client_error','provider_error','timeout','network_error'));
ALTER TABLE public.provider_call_events
  ADD COLUMN IF NOT EXISTS operation TEXT NOT NULL DEFAULT 'request'
  CHECK(operation ~ '^[a-z0-9_-]{2,40}$');

UPDATE public.provider_call_events
SET outcome='client_error'
WHERE outcome='provider_error' AND status_code BETWEEN 400 AND 499
  AND status_code NOT IN (401,403,408,429);

CREATE FUNCTION public.record_provider_call(p_provider TEXT,p_service TEXT,p_operation TEXT,p_method TEXT,p_outcome TEXT,p_status_code INT,p_duration_ms INT,p_error_code TEXT DEFAULT NULL)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  INSERT INTO public.provider_call_events(provider,service,operation,method,outcome,status_code,duration_ms,error_code)
  VALUES(lower(p_provider),lower(p_service),lower(p_operation),upper(p_method),p_outcome,p_status_code,greatest(0,least(p_duration_ms,120000)),p_error_code);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.record_provider_call(TEXT,TEXT,TEXT,TEXT,TEXT,INT,INT,TEXT) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.record_provider_call(TEXT,TEXT,TEXT,TEXT,TEXT,INT,INT,TEXT) TO service_role;

CREATE OR REPLACE FUNCTION public.provider_operations_report() RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
WITH active AS (SELECT provider,service FROM public.monitored_provider_services WHERE enabled), health AS (
  SELECT a.provider,a.service,
    count(e.id) FILTER(WHERE e.created_at>=now()-interval '15 minutes') calls_15m,
    count(e.id) FILTER(WHERE e.created_at>=now()-interval '15 minutes' AND e.outcome IN ('provider_error','timeout','network_error')) failures_15m,
    count(e.id) FILTER(WHERE e.created_at>=now()-interval '15 minutes' AND e.outcome='client_error') client_errors_15m,
    round(avg(e.duration_ms) FILTER(WHERE e.created_at>=now()-interval '15 minutes')) avg_latency_15m,
    max(e.duration_ms) FILTER(WHERE e.created_at>=now()-interval '15 minutes') max_latency_15m,
    count(e.id) calls_24h,
    count(e.id) FILTER(WHERE e.outcome IN ('provider_error','timeout','network_error')) failures_24h,
    count(e.id) FILTER(WHERE e.outcome='client_error') client_errors_24h,
    max(e.created_at) FILTER(WHERE e.outcome='success') last_success_at,
    max(e.created_at) FILTER(WHERE e.outcome IN ('provider_error','timeout','network_error')) last_failure_at
  FROM active a LEFT JOIN public.provider_call_events e ON e.provider=a.provider AND e.service=a.service AND e.created_at>=now()-interval '24 hours'
  GROUP BY a.provider,a.service
), campaigns AS (
 SELECT count(*) FILTER(WHERE status IN ('approved','sending')) active,count(*) FILTER(WHERE status='failed') failed,count(*) FILTER(WHERE status='sent') completed FROM public.marketing_campaigns
), recipients AS (
 SELECT count(*) FILTER(WHERE status='pending') pending,count(*) FILTER(WHERE status='sending') sending,count(*) FILTER(WHERE status='sent') sent,count(*) FILTER(WHERE status='failed') failed,count(*) FILTER(WHERE status='suppressed') suppressed FROM public.marketing_campaign_recipients
)
SELECT jsonb_build_object('generated_at',now(),'providers',COALESCE((SELECT jsonb_agg(jsonb_build_object(
 'provider',h.provider,'service',h.service,'calls_15m',h.calls_15m,'failures_15m',h.failures_15m,'client_errors_15m',h.client_errors_15m,
 'failure_rate_15m',round(100.0*h.failures_15m/nullif(h.calls_15m,0),2),'avg_latency_15m',h.avg_latency_15m,'max_latency_15m',h.max_latency_15m,
 'calls_24h',h.calls_24h,'failures_24h',h.failures_24h,'client_errors_24h',h.client_errors_24h,
 'failure_rate_24h',round(100.0*h.failures_24h/nullif(h.calls_24h,0),2),'last_success_at',h.last_success_at,'last_failure_at',h.last_failure_at,
 'recent_issues',COALESCE((SELECT jsonb_agg(to_jsonb(i) ORDER BY i.occurred_at DESC) FROM (
   SELECT e.created_at occurred_at,e.operation,e.outcome,e.status_code,e.error_code
   FROM public.provider_call_events e WHERE e.provider=h.provider AND e.service=h.service
     AND e.created_at>=now()-interval '24 hours' AND e.outcome IN ('provider_error','timeout','network_error')
   ORDER BY e.created_at DESC LIMIT 10
 ) i),'[]'::jsonb)
) ORDER BY h.provider,h.service) FROM health h),'[]'::jsonb),
'campaigns',(SELECT to_jsonb(campaigns) FROM campaigns),'recipients',(SELECT to_jsonb(recipients) FROM recipients));
$$;
REVOKE EXECUTE ON FUNCTION public.provider_operations_report() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.provider_operations_report() TO service_role;
