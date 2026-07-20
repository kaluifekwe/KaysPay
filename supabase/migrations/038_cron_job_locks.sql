-- Kay's Pay: prevent overlapping runs of the same cron sweep
-- =====================================================================
-- Found in the scalability audit (2026-07-06): the 5 cron-only functions
-- (vtu-reconcile, esim-reconcile, nin-reconcile, vtuafrica-reconcile,
-- payroll-execute) have no guard against a sweep still running when the
-- next scheduled tick fires — as pending-row counts grow, two overlapping
-- runs could both pick up and redundantly re-query the same pending order
-- against the provider. Not a money-safety bug (the underlying RPCs are
-- row-locked and safely no-op on an already-settled transaction), but
-- wasteful and worth closing off.
--
-- Deliberately NOT using Postgres session advisory locks
-- (pg_try_advisory_lock/pg_advisory_unlock): Edge Functions reach Postgres
-- through PostgREST's pooled connections, so the "acquire" and "release"
-- RPC calls (made minutes apart, at the start and end of a long-running
-- sweep) can land on two DIFFERENT underlying connections. A session-level
-- lock can only be released by the same session that took it — releasing
-- from a different connection is a silent no-op, which would leave the
-- lock stuck forever and permanently block every future run. A plain
-- table row sidesteps that entirely, and self-expires if a run ever dies
-- without releasing it (e.g. hits the platform's execution time limit).
-- =====================================================================

CREATE TABLE IF NOT EXISTS cron_job_locks (
  job_name     TEXT PRIMARY KEY,
  locked_at    TIMESTAMPTZ NOT NULL,
  locked_until TIMESTAMPTZ NOT NULL
);

-- Acquires the lock if free, or if the previous holder's lock has already
-- expired (a stale lock from a run that died without releasing it — e.g.
-- hit the Edge Function platform's wall-clock limit). Returns whether the
-- caller now holds it.
CREATE OR REPLACE FUNCTION public.try_acquire_job_lock(p_job_name TEXT, p_hold_seconds INT DEFAULT 200)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_acquired BOOLEAN;
BEGIN
  INSERT INTO cron_job_locks (job_name, locked_at, locked_until)
  VALUES (p_job_name, now(), now() + make_interval(secs => p_hold_seconds))
  ON CONFLICT (job_name) DO UPDATE
    SET locked_at = now(), locked_until = now() + make_interval(secs => p_hold_seconds)
    WHERE cron_job_locks.locked_until < now()
  RETURNING TRUE INTO v_acquired;

  RETURN COALESCE(v_acquired, FALSE);
END;
$$;

CREATE OR REPLACE FUNCTION public.release_job_lock(p_job_name TEXT)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM cron_job_locks WHERE job_name = p_job_name;
$$;

GRANT EXECUTE ON FUNCTION public.try_acquire_job_lock(TEXT, INT) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_job_lock(TEXT) TO service_role;
