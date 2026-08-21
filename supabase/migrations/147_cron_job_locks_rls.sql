-- Enable RLS on cron_job_locks (2026-08-21).
-- =====================================================================
-- Closes the last gap found by the 2026-08-21 security review (F-6):
-- cron_job_locks was the only table in the schema without row level
-- security enabled.
--
-- This is defence in depth, NOT a live exposure. Migration 057 already
-- does REVOKE ALL ON TABLE ... public.cron_job_locks ... FROM anon,
-- authenticated, so no client role can reach the table today, and the
-- helpers that use it (try_acquire_job_lock / release_job_lock) are
-- SECURITY DEFINER and granted to service_role only.
--
-- The reason to enable RLS anyway: a GRANT is a single statement away from
-- being undone by a future migration that adds a broad grant, and nothing
-- would flag it. With RLS on and no permissive policy, the table stays
-- closed to every non-service role even if a grant is reopened by mistake.
-- service_role bypasses RLS, so the cron sweeps are unaffected.
--
-- No policy is created deliberately: RLS enabled with zero policies denies
-- all access to non-bypassing roles, which is exactly the intent.

ALTER TABLE public.cron_job_locks ENABLE ROW LEVEL SECURITY;

-- Re-assert the privilege boundary alongside the RLS flag so the two can't
-- drift apart, matching how 057 pairs REVOKE with its own assertions.
REVOKE ALL ON TABLE public.cron_job_locks FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.cron_job_locks TO service_role;

-- Deployment-time assertions, same discipline as 057 and 146.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'cron_job_locks' AND c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'SECURITY_ASSERTION_FAILED: RLS not enabled on cron_job_locks';
  END IF;
  IF has_table_privilege('authenticated', 'public.cron_job_locks', 'SELECT') THEN
    RAISE EXCEPTION 'SECURITY_ASSERTION_FAILED: client can read cron_job_locks';
  END IF;
  IF has_table_privilege('anon', 'public.cron_job_locks', 'SELECT') THEN
    RAISE EXCEPTION 'SECURITY_ASSERTION_FAILED: anon can read cron_job_locks';
  END IF;
END $$;
