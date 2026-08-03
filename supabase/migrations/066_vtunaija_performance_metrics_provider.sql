-- Kay's Pay: allow 'vtunaija' in vtu_performance_metrics.provider
-- =====================================================================
-- Migration 063 created this table with an unnamed column CHECK, which
-- Postgres auto-named vtu_performance_metrics_provider_check (the default
-- <table>_<column>_check convention). It only allowed ('vtu_ng','vtuafrica'),
-- which would silently reject every telemetry row for airtime purchases now
-- routed to the new VTUnaija provider (writes are wrapped in best-effort
-- error handling in vtu-purchase, so a rejected insert never breaks a real
-- purchase — it would only silently lose telemetry for those purchases until
-- this fix). 'vtu_ng' stays in the allowed list for rollback safety even
-- though nothing currently routes there for airtime.
-- =====================================================================

ALTER TABLE public.vtu_performance_metrics
  DROP CONSTRAINT IF EXISTS vtu_performance_metrics_provider_check;

ALTER TABLE public.vtu_performance_metrics
  ADD CONSTRAINT vtu_performance_metrics_provider_check
  CHECK (provider IN ('vtu_ng', 'vtuafrica', 'vtunaija'));
