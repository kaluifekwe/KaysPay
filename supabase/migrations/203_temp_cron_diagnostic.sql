-- TEMP diagnostic: expose pg_cron's own job + recent run history for
-- provider-health-monitor, to find out why it never alerted during a real
-- ~12-minute VTUNaija outage despite its own thresholds being met partway
-- through. Read-only. Will be dropped again once the investigation is done.
CREATE OR REPLACE FUNCTION public.tmp_diag_cron_status(p_jobname TEXT)
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, cron AS $$
  SELECT jsonb_build_object(
    'job', (SELECT to_jsonb(j) FROM cron.job j WHERE j.jobname = p_jobname),
    'recent_runs', COALESCE((
      SELECT jsonb_agg(to_jsonb(r) ORDER BY r.start_time DESC)
      FROM (
        SELECT status, return_message, start_time, end_time
        FROM cron.job_run_details
        WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = p_jobname)
        ORDER BY start_time DESC LIMIT 10
      ) r
    ), '[]'::jsonb)
  );
$$;
REVOKE EXECUTE ON FUNCTION public.tmp_diag_cron_status(TEXT) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.tmp_diag_cron_status(TEXT) TO service_role;
