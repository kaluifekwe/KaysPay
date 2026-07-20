-- 045_drop_payroll_betting.sql
--
-- Removes the payroll feature from the database entirely. Payroll and betting
-- were removed from the app (client screens/services, Edge Functions, catalog
-- entries) in the same change; this migration drops the server-side objects
-- that only the deleted code ever used.
--
-- Betting has NO dedicated database objects — it rode on the shared
-- `transactions` table (recorded with type 'bill') and catalog constants that
-- lived only in code, so there is nothing to drop for it here.
--
-- Payroll owns: the `scheduled_payrolls` table, ~10 RPCs, and the
-- `payroll-execute-due` cron job (already unscheduled in migration 044).
--
-- Safety: verified 0 active payroll mandates and 0 payroll rows before this
-- change, so dropping is data-safe. The `transactions.type` CHECK constraint
-- is deliberately LEFT UNTOUCHED — a historically-allowed value it no longer
-- receives is harmless, and the constraint is shared with every other service.
--
-- This is forward-only. To restore payroll, re-apply migrations 029/031/032/
-- 037/039 (the snapshot commit preceding this removal has the code).

-- 1. Make sure the cron job is gone. Migration 044 already unscheduled it; this
--    is a belt-and-braces no-op if it is already absent (unschedule raises when
--    the job name is missing, so swallow that).
DO $$
BEGIN
  PERFORM cron.unschedule('payroll-execute-due');
EXCEPTION
  WHEN OTHERS THEN NULL;
END $$;

-- 2. Drop every payroll RPC, across all overloaded signatures, by name. Doing
--    it by name (rather than spelling out each argument list) means we catch
--    every historical overload — e.g. create_payroll and advance_payroll_
--    schedule / finish_payroll_run each gained an extra argument over 031→039.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'schedule_payroll',
        'refund_payroll',
        'claim_due_payrolls',
        'create_payroll',
        'update_payroll',
        'debit_payroll_run',
        'advance_payroll_schedule',
        'finish_payroll_run',
        'skip_payroll_run',
        'cancel_payroll'
      )
  LOOP
    EXECUTE 'DROP FUNCTION IF EXISTS ' || r.sig || ' CASCADE';
  END LOOP;
END $$;

-- 3. Drop the table last (CASCADE also removes its RLS policies and indexes).
DROP TABLE IF EXISTS public.scheduled_payrolls CASCADE;
