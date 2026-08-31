-- Active provider/service inventory and service-level telemetry.
-- SMSPVA and GrizzlySMS are deliberately excluded because they are not in use.
ALTER TABLE public.provider_call_events
  ADD COLUMN IF NOT EXISTS service TEXT NOT NULL DEFAULT 'external'
  CHECK(service ~ '^[a-z0-9_-]{2,40}$');

CREATE TABLE public.monitored_provider_services (
  provider TEXT NOT NULL CHECK(provider ~ '^[a-z0-9_-]{2,40}$'),
  service TEXT NOT NULL CHECK(service ~ '^[a-z0-9_-]{2,40}$'),
  enabled BOOLEAN NOT NULL DEFAULT true,
  PRIMARY KEY(provider,service)
);
ALTER TABLE public.monitored_provider_services ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.monitored_provider_services FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.monitored_provider_services TO service_role;

INSERT INTO public.monitored_provider_services(provider,service) VALUES
 ('vtunaija','airtime'),('vtunaija','data'),('vtunaija','electricity'),('vtunaija','cable_tv'),('vtunaija','exam_pins'),
 ('quidax','crypto'),('flutterwave','wallet_funding'),('flutterwave','bank_transfer'),
 ('paystack','wallet_funding'),('paystack','bank_transfer'),('airalo','esim'),
 ('prembly','identity'),('checkmyninbvn','identity'),('resend','email'),('groq','admin_ai'),
 ('expo','push_notifications'),('open_er_api','exchange_rate')
ON CONFLICT(provider,service) DO UPDATE SET enabled=true;

CREATE FUNCTION public.record_provider_call(p_provider TEXT,p_service TEXT,p_method TEXT,p_outcome TEXT,p_status_code INT,p_duration_ms INT,p_error_code TEXT DEFAULT NULL)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  INSERT INTO public.provider_call_events(provider,service,method,outcome,status_code,duration_ms,error_code)
  VALUES(lower(p_provider),lower(p_service),upper(p_method),p_outcome,p_status_code,greatest(0,least(p_duration_ms,120000)),p_error_code);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.record_provider_call(TEXT,TEXT,TEXT,TEXT,INT,INT,TEXT) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.record_provider_call(TEXT,TEXT,TEXT,TEXT,INT,INT,TEXT) TO service_role;

CREATE OR REPLACE FUNCTION public.provider_operations_report() RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
WITH active AS (
  SELECT provider,service FROM public.monitored_provider_services WHERE enabled
), health AS (
  SELECT a.provider,a.service,
    count(e.id) FILTER(WHERE e.created_at>=now()-interval '15 minutes') calls_15m,
    count(e.id) FILTER(WHERE e.created_at>=now()-interval '15 minutes' AND e.outcome<>'success') failures_15m,
    round(avg(e.duration_ms) FILTER(WHERE e.created_at>=now()-interval '15 minutes')) avg_latency_15m,
    max(e.duration_ms) FILTER(WHERE e.created_at>=now()-interval '15 minutes') max_latency_15m,
    count(e.id) calls_24h,
    count(e.id) FILTER(WHERE e.outcome<>'success') failures_24h,
    max(e.created_at) FILTER(WHERE e.outcome='success') last_success_at,
    max(e.created_at) FILTER(WHERE e.outcome<>'success') last_failure_at
  FROM active a LEFT JOIN public.provider_call_events e
    ON e.provider=a.provider AND e.service=a.service AND e.created_at>=now()-interval '24 hours'
  GROUP BY a.provider,a.service
), campaigns AS (
  SELECT count(*) FILTER(WHERE status IN ('approved','sending')) active,
    count(*) FILTER(WHERE status='failed') failed,count(*) FILTER(WHERE status='sent') completed FROM public.marketing_campaigns
), recipients AS (
  SELECT count(*) FILTER(WHERE status='pending') pending,count(*) FILTER(WHERE status='sending') sending,
    count(*) FILTER(WHERE status='sent') sent,count(*) FILTER(WHERE status='failed') failed,
    count(*) FILTER(WHERE status='suppressed') suppressed FROM public.marketing_campaign_recipients
)
SELECT jsonb_build_object('generated_at',now(),
  'providers',COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'provider',provider,'service',service,'calls_15m',calls_15m,'failures_15m',failures_15m,
    'failure_rate_15m',round(100.0*failures_15m/nullif(calls_15m,0),2),
    'avg_latency_15m',avg_latency_15m,'max_latency_15m',max_latency_15m,
    'calls_24h',calls_24h,'failures_24h',failures_24h,
    'failure_rate_24h',round(100.0*failures_24h/nullif(calls_24h,0),2),
    'last_success_at',last_success_at,'last_failure_at',last_failure_at
  ) ORDER BY provider,service) FROM health),'[]'::jsonb),
  'campaigns',(SELECT to_jsonb(campaigns) FROM campaigns),
  'recipients',(SELECT to_jsonb(recipients) FROM recipients));
$$;
REVOKE EXECUTE ON FUNCTION public.provider_operations_report() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.provider_operations_report() TO service_role;

DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM public.monitored_provider_services WHERE provider IN ('smspva','grizzlysms')) THEN
    RAISE EXCEPTION 'INACTIVE_PROVIDER_REGISTERED';
  END IF;
END $$;
