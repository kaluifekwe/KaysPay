ALTER TABLE public.monitoring_alerts
  ADD COLUMN IF NOT EXISTS incident_analysis JSONB CHECK(incident_analysis IS NULL OR length(incident_analysis::TEXT)<=5000),
  ADD COLUMN IF NOT EXISTS analysis_model TEXT CHECK(analysis_model IS NULL OR length(analysis_model)<=80),
  ADD COLUMN IF NOT EXISTS analysis_generated_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_monitoring_provider_incidents
  ON public.monitoring_alerts(status,last_seen_at DESC)
  WHERE fingerprint LIKE 'provider_%_health';

DO $$ BEGIN
  IF has_table_privilege('authenticated','public.monitoring_alerts','SELECT') THEN
    RAISE EXCEPTION 'SECURITY_ASSERTION_FAILED: incidents exposed';
  END IF;
END $$;
