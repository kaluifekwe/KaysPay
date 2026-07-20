-- Kay's Pay: prune pg_cron's own run-log table
-- =====================================================================
-- Found while sizing the database for growth (2026-07-06): cron.job_run_details
-- was already the single LARGEST table (3.5MB from just 5 days / 3,460 rows,
-- ~692 rows/day) despite the app itself having very little real data yet.
-- pg_cron logs every run of every job forever with no built-in cleanup — this
-- grows with TIME, not with user count, so it keeps growing even with zero
-- new users. Left alone this is on track for roughly 250MB+ a year, which
-- would eventually compete with real user data for the free tier's 500MB cap.
--
-- Standard fix (Supabase's own recommended pattern): schedule a daily job
-- that deletes its own log rows older than 7 days. We don't need history
-- older than that — these logs are only useful for debugging a recent
-- failure, not as a permanent record (real business data lives in
-- `transactions`, which this does not touch).
-- =====================================================================

SELECT cron.schedule(
  'cron-job-run-details-cleanup',
  '0 3 * * *', -- once daily at 03:00 UTC (04:00 WAT) — low-traffic hour
  $$
  DELETE FROM cron.job_run_details
  WHERE end_time < now() - interval '7 days';
  $$
);
