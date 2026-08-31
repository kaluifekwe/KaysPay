-- Phase 7A/7B: automatic campaign delivery and sanitized provider health.

ALTER TABLE public.marketing_campaign_recipients
  ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS bounced_at TIMESTAMPTZ;

CREATE TABLE public.provider_call_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider ~ '^[a-z0-9_-]{2,40}$'),
  method TEXT NOT NULL CHECK (method IN ('GET','POST','PUT','PATCH','DELETE','OTHER')),
  outcome TEXT NOT NULL CHECK (outcome IN ('success','provider_error','timeout','network_error')),
  status_code SMALLINT CHECK (status_code IS NULL OR status_code BETWEEN 100 AND 599),
  duration_ms INT NOT NULL CHECK (duration_ms BETWEEN 0 AND 120000),
  error_code TEXT CHECK (error_code IS NULL OR error_code ~ '^[A-Z0-9_]{2,40}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_provider_call_events_health ON public.provider_call_events(provider,created_at DESC);
ALTER TABLE public.provider_call_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.provider_call_events FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,DELETE ON public.provider_call_events TO service_role;

CREATE FUNCTION public.record_provider_call(p_provider TEXT,p_method TEXT,p_outcome TEXT,p_status_code INT,p_duration_ms INT,p_error_code TEXT DEFAULT NULL)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  INSERT INTO public.provider_call_events(provider,method,outcome,status_code,duration_ms,error_code)
  VALUES(lower(p_provider),upper(p_method),p_outcome,p_status_code,greatest(0,least(p_duration_ms,120000)),p_error_code);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.record_provider_call(TEXT,TEXT,TEXT,INT,INT,TEXT) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.record_provider_call(TEXT,TEXT,TEXT,INT,INT,TEXT) TO service_role;

CREATE FUNCTION public.provider_operations_report() RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
WITH providers AS (
  SELECT provider,
    count(*) FILTER(WHERE created_at>=now()-interval '15 minutes') calls_15m,
    count(*) FILTER(WHERE created_at>=now()-interval '15 minutes' AND outcome<>'success') failures_15m,
    round(avg(duration_ms) FILTER(WHERE created_at>=now()-interval '15 minutes')) avg_latency_15m,
    max(duration_ms) FILTER(WHERE created_at>=now()-interval '15 minutes') max_latency_15m,
    count(*) FILTER(WHERE created_at>=now()-interval '24 hours') calls_24h,
    count(*) FILTER(WHERE created_at>=now()-interval '24 hours' AND outcome<>'success') failures_24h,
    max(created_at) last_seen_at,
    max(created_at) FILTER(WHERE outcome<>'success') last_failure_at
  FROM public.provider_call_events WHERE created_at>=now()-interval '24 hours' GROUP BY provider
), campaigns AS (
  SELECT count(*) FILTER(WHERE status IN ('approved','sending')) active,
    count(*) FILTER(WHERE status='failed') failed,
    count(*) FILTER(WHERE status='sent') completed FROM public.marketing_campaigns
), recipients AS (
  SELECT count(*) FILTER(WHERE status='pending') pending,count(*) FILTER(WHERE status='sending') sending,
    count(*) FILTER(WHERE status='sent') sent,count(*) FILTER(WHERE status='failed') failed,
    count(*) FILTER(WHERE status='suppressed') suppressed FROM public.marketing_campaign_recipients
)
SELECT jsonb_build_object(
  'generated_at',now(),
  'providers',COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'provider',provider,'calls_15m',calls_15m,'failures_15m',failures_15m,
    'failure_rate_15m',round(100.0*failures_15m/nullif(calls_15m,0),2),
    'avg_latency_15m',avg_latency_15m,'max_latency_15m',max_latency_15m,
    'calls_24h',calls_24h,'failures_24h',failures_24h,
    'failure_rate_24h',round(100.0*failures_24h/nullif(calls_24h,0),2),
    'last_seen_at',last_seen_at,'last_failure_at',last_failure_at
  ) ORDER BY failures_15m DESC,provider) FROM providers),'[]'::jsonb),
  'campaigns',(SELECT to_jsonb(campaigns) FROM campaigns),
  'recipients',(SELECT to_jsonb(recipients) FROM recipients)
);
$$;
REVOKE EXECUTE ON FUNCTION public.provider_operations_report() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.provider_operations_report() TO service_role;

CREATE FUNCTION public.cleanup_provider_call_events() RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_count INT; BEGIN DELETE FROM public.provider_call_events WHERE created_at<now()-interval '30 days'; GET DIAGNOSTICS v_count=ROW_COUNT; RETURN v_count; END;
$$;
REVOKE EXECUTE ON FUNCTION public.cleanup_provider_call_events() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_provider_call_events() TO service_role;

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
SELECT cron.unschedule('marketing-campaign-dispatch') WHERE EXISTS(SELECT 1 FROM cron.job WHERE jobname='marketing-campaign-dispatch');
SELECT cron.schedule('marketing-campaign-dispatch','* * * * *',$$
  SELECT net.http_post(url:='https://xswlrzhtxrzugoxdonjc.supabase.co/functions/v1/campaign-dispatch-worker',
    headers:=jsonb_build_object('Content-Type','application/json','x-cron-secret',(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='cron_secret')),
    body:='{}'::jsonb,timeout_milliseconds:=55000)
$$);
SELECT cron.unschedule('provider-health-monitor') WHERE EXISTS(SELECT 1 FROM cron.job WHERE jobname='provider-health-monitor');
SELECT cron.schedule('provider-health-monitor','*/5 * * * *',$$
  SELECT net.http_post(url:='https://xswlrzhtxrzugoxdonjc.supabase.co/functions/v1/provider-health-monitor',
    headers:=jsonb_build_object('Content-Type','application/json','x-cron-secret',(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='cron_secret')),
    body:='{}'::jsonb,timeout_milliseconds:=55000)
$$);
SELECT cron.unschedule('provider-telemetry-retention') WHERE EXISTS(SELECT 1 FROM cron.job WHERE jobname='provider-telemetry-retention');
SELECT cron.schedule('provider-telemetry-retention','41 3 * * *','SELECT public.cleanup_provider_call_events()');

DO $$ BEGIN
  IF has_table_privilege('authenticated','public.provider_call_events','SELECT') THEN RAISE EXCEPTION 'SECURITY_ASSERTION_FAILED: provider telemetry exposed'; END IF;
END $$;
