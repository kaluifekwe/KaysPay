-- Kay's Pay Phase 5: read-only financial integrity monitoring and service controls.
CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON public.transactions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_pending_type_created ON public.transactions(type,created_at) WHERE status='pending';
CREATE INDEX IF NOT EXISTS idx_transactions_provider_ref ON public.transactions(vtu_order_id) WHERE vtu_order_id IS NOT NULL;

CREATE TABLE public.service_controls (
  service TEXT PRIMARY KEY CHECK (service IN ('vtu','esim','foreign_number','identity')),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  reason TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO public.service_controls(service) VALUES ('vtu'),('esim'),('foreign_number'),('identity')
ON CONFLICT(service) DO NOTHING;

CREATE TABLE public.monitoring_alerts (
  fingerprint TEXT PRIMARY KEY,
  alert_type TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('warning','critical')),
  details JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (length(details::TEXT)<=2048),
  occurrence_count INT NOT NULL DEFAULT 1,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_alerted_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ
);
CREATE INDEX idx_monitoring_alerts_open ON public.monitoring_alerts(last_seen_at DESC) WHERE resolved_at IS NULL;

CREATE TABLE public.monitoring_runs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  metrics JSONB NOT NULL CHECK (length(metrics::TEXT)<=8192),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_monitoring_runs_created ON public.monitoring_runs(created_at DESC);

CREATE TABLE public.monitoring_daily_reports (
  report_date DATE PRIMARY KEY,
  metrics JSONB NOT NULL CHECK (length(metrics::TEXT)<=8192),
  emailed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.service_controls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.monitoring_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.monitoring_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.monitoring_daily_reports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.service_controls,public.monitoring_alerts,public.monitoring_runs,public.monitoring_daily_reports FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.service_controls,public.monitoring_alerts,public.monitoring_runs,public.monitoring_daily_reports TO service_role;

CREATE FUNCTION public.is_service_enabled(p_service TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT COALESCE((SELECT enabled FROM public.service_controls WHERE service=p_service), FALSE)
$$;

CREATE FUNCTION public.collect_financial_integrity_metrics()
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT jsonb_build_object(
    'negative_wallets',(SELECT count(*) FROM public.wallets WHERE balance<0 OR locked_amount<0 OR locked_amount>balance),
    'stuck_vtu',(SELECT count(*) FROM public.transactions WHERE status='pending' AND type IN ('airtime','data','bill','exam_pin') AND created_at<now()-INTERVAL '20 minutes'),
    'stuck_foreign_numbers',(SELECT count(*) FROM public.transactions WHERE status='pending' AND type='foreign_number' AND created_at<now()-INTERVAL '30 minutes'),
    'stuck_identity',(SELECT count(*) FROM public.transactions WHERE status='pending' AND type IN ('nin_validation','nin_name_modification','nin_phone_modification','nin_address_modification') AND created_at<now()-INTERVAL '72 hours'),
    'duplicate_provider_refs',(SELECT count(*) FROM (SELECT vtu_order_id FROM public.transactions WHERE vtu_order_id IS NOT NULL AND created_at>now()-INTERVAL '30 days' GROUP BY vtu_order_id HAVING count(*)>1) d),
    'pending_total',(SELECT count(*) FROM public.transactions WHERE status='pending'),
    'completed_24h',(SELECT count(*) FROM public.transactions WHERE status='completed' AND created_at>now()-INTERVAL '24 hours'),
    'failed_24h',(SELECT count(*) FROM public.transactions WHERE status='failed' AND created_at>now()-INTERVAL '24 hours'),
    'refunded_24h',(SELECT count(*) FROM public.transactions WHERE status='refunded' AND created_at>now()-INTERVAL '24 hours'),
    'volume_kobo_24h',(SELECT COALESCE(sum(amount_ngn),0) FROM public.transactions WHERE status='completed' AND created_at>now()-INTERVAL '24 hours'),
    'burst_accounts',(SELECT count(*) FROM (SELECT user_id FROM public.transactions WHERE created_at>now()-INTERVAL '1 hour' GROUP BY user_id HAVING count(*)>50) b)
  )
$$;

CREATE FUNCTION public.record_monitoring_alert(p_fingerprint TEXT,p_type TEXT,p_severity TEXT,p_details JSONB)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_should_email BOOLEAN;
BEGIN
  IF p_fingerprint !~ '^[a-z0-9_-]{3,100}$' OR p_severity NOT IN ('warning','critical') OR length(COALESCE(p_details,'{}')::TEXT)>2048 THEN
    RAISE EXCEPTION 'INVALID_MONITORING_ALERT';
  END IF;
  INSERT INTO public.monitoring_alerts(fingerprint,alert_type,severity,details,last_alerted_at)
  VALUES(p_fingerprint,p_type,p_severity,COALESCE(p_details,'{}'),now())
  ON CONFLICT(fingerprint) DO UPDATE SET occurrence_count=public.monitoring_alerts.occurrence_count+1,
    details=EXCLUDED.details,last_seen_at=now(),resolved_at=NULL,
    last_alerted_at=CASE WHEN public.monitoring_alerts.last_alerted_at<now()-INTERVAL '6 hours' THEN now() ELSE public.monitoring_alerts.last_alerted_at END
  RETURNING last_alerted_at>now()-INTERVAL '5 seconds' INTO v_should_email;
  RETURN v_should_email;
END $$;

CREATE FUNCTION public.record_monitoring_run(p_metrics JSONB)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  INSERT INTO public.monitoring_runs(metrics) VALUES(p_metrics);
  DELETE FROM public.monitoring_runs WHERE created_at<now()-INTERVAL '90 days';
END $$;

CREATE FUNCTION public.claim_daily_monitoring_report(p_date DATE,p_metrics JSONB)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  INSERT INTO public.monitoring_daily_reports(report_date,metrics) VALUES(p_date,p_metrics) ON CONFLICT DO NOTHING;
  RETURN FOUND;
END $$;

REVOKE EXECUTE ON FUNCTION public.is_service_enabled(TEXT) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.collect_financial_integrity_metrics() FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.record_monitoring_alert(TEXT,TEXT,TEXT,JSONB) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.record_monitoring_run(JSONB) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.claim_daily_monitoring_report(DATE,JSONB) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.is_service_enabled(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.collect_financial_integrity_metrics() TO service_role;
GRANT EXECUTE ON FUNCTION public.record_monitoring_alert(TEXT,TEXT,TEXT,JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_monitoring_run(JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_daily_monitoring_report(DATE,JSONB) TO service_role;

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
SELECT cron.unschedule('financial-integrity-monitor') WHERE EXISTS(SELECT 1 FROM cron.job WHERE jobname='financial-integrity-monitor');
SELECT cron.schedule('financial-integrity-monitor','*/10 * * * *',$$
  SELECT net.http_post(
    url:='https://xswlrzhtxrzugoxdonjc.supabase.co/functions/v1/financial-integrity-monitor',
    headers:=jsonb_build_object('Authorization','Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inhzd2xyemh0eHJ6dWdveGRvbmpjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI1MTM3NjcsImV4cCI6MjA5ODA4OTc2N30.i5OKPZC3swGLpiadEdCHuqOhZJWNlyg4FAA-Ndu4uL0','Content-Type','application/json','x-cron-secret',(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='cron_secret')),
    body:='{}'::jsonb,timeout_milliseconds:=60000)
$$);
