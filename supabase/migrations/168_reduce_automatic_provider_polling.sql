-- Reduce provider traffic for the current low-volume launch phase.
--
-- funding-reconcile still wakes every five minutes for prompt recovery, but
-- the Edge Function now contacts only providers with a local unresolved
-- funding_event. These catalogue schedules control freshness only; purchase
-- and verification calls remain on-demand and are unchanged.
--
-- Previous schedules (for rollback):
--   vtunaija-data-catalog-sync        */5 * * * *
--   vtunaija-electricity-catalog-sync */5 * * * *
--   vtunaija-cabletv-catalog-sync     */5 * * * *
--   vtunaija-exam-catalog-sync        */15 * * * *

DO $$
DECLARE
  v_job_id BIGINT;
BEGIN
  SELECT jobid INTO v_job_id FROM cron.job WHERE jobname = 'vtunaija-data-catalog-sync';
  IF v_job_id IS NULL THEN RAISE EXCEPTION 'MISSING_CRON_JOB: vtunaija-data-catalog-sync'; END IF;
  PERFORM cron.alter_job(v_job_id, schedule := '7 * * * *');

  SELECT jobid INTO v_job_id FROM cron.job WHERE jobname = 'vtunaija-electricity-catalog-sync';
  IF v_job_id IS NULL THEN RAISE EXCEPTION 'MISSING_CRON_JOB: vtunaija-electricity-catalog-sync'; END IF;
  PERFORM cron.alter_job(v_job_id, schedule := '17 2 * * *');

  SELECT jobid INTO v_job_id FROM cron.job WHERE jobname = 'vtunaija-cabletv-catalog-sync';
  IF v_job_id IS NULL THEN RAISE EXCEPTION 'MISSING_CRON_JOB: vtunaija-cabletv-catalog-sync'; END IF;
  PERFORM cron.alter_job(v_job_id, schedule := '23 */6 * * *');

  SELECT jobid INTO v_job_id FROM cron.job WHERE jobname = 'vtunaija-exam-catalog-sync';
  IF v_job_id IS NULL THEN RAISE EXCEPTION 'MISSING_CRON_JOB: vtunaija-exam-catalog-sync'; END IF;
  PERFORM cron.alter_job(v_job_id, schedule := '37 * * * *');
END
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM cron.job
    WHERE (jobname = 'vtunaija-data-catalog-sync' AND schedule <> '7 * * * *')
       OR (jobname = 'vtunaija-electricity-catalog-sync' AND schedule <> '17 2 * * *')
       OR (jobname = 'vtunaija-cabletv-catalog-sync' AND schedule <> '23 */6 * * *')
       OR (jobname = 'vtunaija-exam-catalog-sync' AND schedule <> '37 * * * *')
  ) THEN
    RAISE EXCEPTION 'PROVIDER_POLLING_SCHEDULE_ASSERTION_FAILED';
  END IF;
END
$$;
