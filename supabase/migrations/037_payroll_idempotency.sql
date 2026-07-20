-- Kay's Pay: make payroll mandate creation idempotent
-- =====================================================================
-- payroll-schedule already sends an idempotency_key from the client, but
-- nothing server-side ever stored or checked it — meaning the safe-retry
-- pattern applied to every other purchase/action this session (see
-- src/utils/network.ts, invokeWithRetry) couldn't be safely extended to
-- payroll creation: there was no way to tell "did this mandate already get
-- created?" after an ambiguous network failure, only "does the money side
-- (transactions) show anything?" — and create_payroll doesn't touch
-- transactions at all (no debit happens at schedule time, only at each
-- run). This adds the same idempotency guarantee already used for
-- transactions/withdrawals, scoped to scheduled_payrolls instead.
-- =====================================================================

ALTER TABLE scheduled_payrolls ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_scheduled_payrolls_idempotency_key
  ON scheduled_payrolls (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Adding a new trailing parameter to an existing function creates a NEW
-- overload rather than replacing it — drop the old signature first (bit
-- this codebase before with verify_user_pin/credit_wallet_funding).
DROP FUNCTION IF EXISTS public.create_payroll(UUID, TEXT, JSONB, BIGINT, TEXT, TIMESTAMPTZ);

CREATE OR REPLACE FUNCTION public.create_payroll(
  p_user_id          UUID,
  p_service_type     TEXT,
  p_recipients       JSONB,
  p_total            BIGINT,   -- kobo per cycle (informational)
  p_frequency        TEXT,
  p_first_run        TIMESTAMPTZ,
  p_idempotency_key  TEXT DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id UUID;
BEGIN
  -- Replay: this exact request already created a mandate — return it as-is,
  -- don't create a second one.
  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_id FROM scheduled_payrolls WHERE idempotency_key = p_idempotency_key;
    IF v_id IS NOT NULL THEN
      RETURN v_id;
    END IF;
  END IF;

  IF p_total IS NULL OR p_total <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT';
  END IF;
  IF p_first_run <= now() THEN
    RAISE EXCEPTION 'INVALID_SCHEDULE_TIME';
  END IF;

  INSERT INTO scheduled_payrolls
    (user_id, service_type, recipients, total_amount, scheduled_for, next_run, frequency, status, active, idempotency_key)
  VALUES
    (p_user_id, p_service_type, p_recipients, p_total, p_first_run, p_first_run, p_frequency, 'active', TRUE, p_idempotency_key)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_payroll(UUID, TEXT, JSONB, BIGINT, TEXT, TIMESTAMPTZ, TEXT) TO service_role;
