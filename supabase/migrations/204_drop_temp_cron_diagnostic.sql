-- Drops the temporary diagnostic function from migration 203, used to
-- confirm provider-health-monitor's cron was firing on schedule during the
-- 2026-09-03 VTUNaija outage investigation. No longer needed.
DROP FUNCTION IF EXISTS public.tmp_diag_cron_status(TEXT);
