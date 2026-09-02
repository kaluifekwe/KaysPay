-- vtunaija-data-catalog-sync was reduced from */5 to hourly (migration 168)
-- to cut provider traffic, but vtu-purchase's own CATALOG_STALE_MS is 30
-- minutes -- so for roughly the second half of every hour, every data
-- purchase depended entirely on its own inline on-demand refresh succeeding
-- (see refreshVtunaijaCatalogInline in supabase/functions/vtu-purchase).
-- A real customer hit exactly this: "Prices are being refreshed" on a Glo
-- bundle, nothing charged, but nothing logged anywhere either since a
-- pre-debit validation failure never creates a transaction row.
--
-- Every 15 minutes keeps the catalog comfortably under the 30-minute
-- threshold at all times, while still cutting provider traffic 4x versus
-- the original */5 schedule.
DO $$
DECLARE
  v_job_id BIGINT;
BEGIN
  SELECT jobid INTO v_job_id FROM cron.job WHERE jobname = 'vtunaija-data-catalog-sync';
  IF v_job_id IS NULL THEN RAISE EXCEPTION 'MISSING_CRON_JOB: vtunaija-data-catalog-sync'; END IF;
  PERFORM cron.alter_job(v_job_id, schedule := '*/15 * * * *');
END
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM cron.job
    WHERE jobname = 'vtunaija-data-catalog-sync' AND schedule <> '*/15 * * * *'
  ) THEN
    RAISE EXCEPTION 'DATA_CATALOG_SCHEDULE_ASSERTION_FAILED';
  END IF;
END
$$;
