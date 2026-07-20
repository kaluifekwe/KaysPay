-- Kay's Pay: convert payrolls to recurring standing-orders
-- =====================================================================
-- A recurring "salary" payroll can't be pre-funded (open-ended total), so
-- the money model changes from charge-at-schedule to CHARGE-AT-EACH-RUN.
-- The user's PIN at setup authorizes the recurring mandate; each cycle the
-- executor debits the wallet and sends. Insufficient funds on a cycle -> that
-- cycle is skipped, the payroll stays active and retries next cycle. Runs
-- until the user cancels.
-- =====================================================================

ALTER TABLE scheduled_payrolls
  ADD COLUMN IF NOT EXISTS frequency  TEXT NOT NULL DEFAULT 'once'
    CHECK (frequency IN ('once', 'weekly', 'monthly')),
  ADD COLUMN IF NOT EXISTS next_run   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS active     BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS run_count  INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_run_at TIMESTAMPTZ;

UPDATE scheduled_payrolls SET next_run = scheduled_for WHERE next_run IS NULL;

-- Broaden the status set: 'active' = live (recurring, or a pending one-time).
ALTER TABLE scheduled_payrolls DROP CONSTRAINT IF EXISTS scheduled_payrolls_status_check;
ALTER TABLE scheduled_payrolls ADD CONSTRAINT scheduled_payrolls_status_check
  CHECK (status IN ('active', 'scheduled', 'processing', 'completed', 'failed', 'cancelled'));

DROP INDEX IF EXISTS idx_scheduled_payrolls_due;
CREATE INDEX IF NOT EXISTS idx_scheduled_payrolls_due
  ON scheduled_payrolls (next_run) WHERE active AND status = 'active';

-- Old pre-charge model functions are replaced below.
DROP FUNCTION IF EXISTS public.schedule_payroll(UUID, TEXT, JSONB, BIGINT, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS public.refund_payroll(UUID, BIGINT, TEXT, JSONB);
DROP FUNCTION IF EXISTS public.claim_due_payrolls(INT);

-- Create a payroll mandate — NO debit here (charge happens at each run).
CREATE OR REPLACE FUNCTION public.create_payroll(
  p_user_id       UUID,
  p_service_type  TEXT,
  p_recipients    JSONB,
  p_total         BIGINT,   -- kobo per cycle (informational)
  p_frequency     TEXT,
  p_first_run     TIMESTAMPTZ
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id UUID;
BEGIN
  IF p_total IS NULL OR p_total <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT';
  END IF;
  IF p_first_run <= now() THEN
    RAISE EXCEPTION 'INVALID_SCHEDULE_TIME';
  END IF;

  INSERT INTO scheduled_payrolls
    (user_id, service_type, recipients, total_amount, scheduled_for, next_run, frequency, status, active)
  VALUES
    (p_user_id, p_service_type, p_recipients, p_total, p_first_run, p_first_run, p_frequency, 'active', TRUE)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_payroll(UUID, TEXT, JSONB, BIGINT, TEXT, TIMESTAMPTZ) TO service_role;

-- Claim due, active payrolls for this run (lock to prevent double-execution).
CREATE OR REPLACE FUNCTION public.claim_due_payrolls(p_limit INT DEFAULT 20)
RETURNS SETOF scheduled_payrolls
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  UPDATE scheduled_payrolls
     SET status = 'processing'
   WHERE id IN (
     SELECT id FROM scheduled_payrolls
      WHERE active AND status = 'active' AND next_run <= now()
      ORDER BY next_run
      LIMIT p_limit
      FOR UPDATE SKIP LOCKED
   )
  RETURNING *;
END;
$$;

GRANT EXECUTE ON FUNCTION public.claim_due_payrolls(INT) TO service_role;

-- Debit the wallet for one cycle + create the collecting transaction. Raises
-- INSUFFICIENT_FUNDS if the balance can't cover this cycle.
CREATE OR REPLACE FUNCTION public.debit_payroll_run(p_payroll_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID;
  v_total   BIGINT;
  v_service TEXT;
  v_count   INT;
  v_balance BIGINT;
  v_tx_id   UUID;
BEGIN
  SELECT user_id, total_amount, service_type, jsonb_array_length(recipients)
    INTO v_user_id, v_total, v_service, v_count
    FROM scheduled_payrolls WHERE id = p_payroll_id;
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'PAYROLL_NOT_FOUND';
  END IF;

  SELECT balance INTO v_balance FROM wallets WHERE user_id = v_user_id FOR UPDATE;
  IF v_balance IS NULL THEN
    RAISE EXCEPTION 'WALLET_NOT_FOUND';
  END IF;
  IF v_balance < v_total THEN
    RAISE EXCEPTION 'INSUFFICIENT_FUNDS';
  END IF;

  UPDATE wallets SET balance = balance - v_total, updated_at = now() WHERE user_id = v_user_id;

  INSERT INTO transactions (user_id, type, amount_ngn, status, metadata)
  VALUES (v_user_id, 'payroll', v_total, 'pending',
          jsonb_build_object('service', v_service, 'recipient_count', v_count, 'payroll_id', p_payroll_id))
  RETURNING id INTO v_tx_id;

  RETURN v_tx_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.debit_payroll_run(UUID) TO service_role;

-- Advance next_run by the payroll's frequency, or deactivate a one-time.
CREATE OR REPLACE FUNCTION public.advance_payroll_schedule(p_payroll_id UUID, p_ran BOOLEAN)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_freq TEXT;
  v_next TIMESTAMPTZ;
BEGIN
  SELECT frequency, next_run INTO v_freq, v_next
    FROM scheduled_payrolls WHERE id = p_payroll_id;

  IF v_freq = 'weekly' THEN
    UPDATE scheduled_payrolls
       SET status = 'active', active = TRUE,
           next_run = GREATEST(v_next + interval '7 days', now() + interval '1 minute'),
           run_count = run_count + (CASE WHEN p_ran THEN 1 ELSE 0 END),
           last_run_at = CASE WHEN p_ran THEN now() ELSE last_run_at END
     WHERE id = p_payroll_id;
  ELSIF v_freq = 'monthly' THEN
    UPDATE scheduled_payrolls
       SET status = 'active', active = TRUE,
           next_run = GREATEST(v_next + interval '1 month', now() + interval '1 minute'),
           run_count = run_count + (CASE WHEN p_ran THEN 1 ELSE 0 END),
           last_run_at = CASE WHEN p_ran THEN now() ELSE last_run_at END
     WHERE id = p_payroll_id;
  ELSE
    -- one-time: done after a real run; if it couldn't run (skipped for funds)
    -- leave it inactive too rather than retry a one-off forever.
    UPDATE scheduled_payrolls
       SET status = CASE WHEN p_ran THEN 'completed' ELSE 'failed' END,
           active = FALSE,
           run_count = run_count + (CASE WHEN p_ran THEN 1 ELSE 0 END),
           last_run_at = CASE WHEN p_ran THEN now() ELSE last_run_at END
     WHERE id = p_payroll_id;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.advance_payroll_schedule(UUID, BOOLEAN) TO service_role;

-- Settle one executed cycle: refund failed recipients' value, mark the tx,
-- store the per-recipient result, and advance the schedule.
CREATE OR REPLACE FUNCTION public.finish_payroll_run(
  p_payroll_id UUID,
  p_tx_id      UUID,
  p_refund     BIGINT,
  p_result     JSONB
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID;
BEGIN
  SELECT user_id INTO v_user_id FROM scheduled_payrolls WHERE id = p_payroll_id;
  IF v_user_id IS NULL THEN RETURN; END IF;

  IF p_refund > 0 THEN
    UPDATE wallets SET balance = balance + p_refund, updated_at = now() WHERE user_id = v_user_id;
  END IF;

  UPDATE transactions
     SET status = 'completed', completed_at = now(),
         metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('refunded_kobo', p_refund, 'result', p_result)
   WHERE id = p_tx_id;

  UPDATE scheduled_payrolls SET result = p_result WHERE id = p_payroll_id;

  PERFORM advance_payroll_schedule(p_payroll_id, TRUE);
END;
$$;

GRANT EXECUTE ON FUNCTION public.finish_payroll_run(UUID, UUID, BIGINT, JSONB) TO service_role;

-- A cycle that couldn't run because funds were short — no debit, just move on.
CREATE OR REPLACE FUNCTION public.skip_payroll_run(p_payroll_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM advance_payroll_schedule(p_payroll_id, FALSE);
END;
$$;

GRANT EXECUTE ON FUNCTION public.skip_payroll_run(UUID) TO service_role;

-- Owner cancels a payroll (stops all future runs).
CREATE OR REPLACE FUNCTION public.cancel_payroll(p_user_id UUID, p_payroll_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_found BOOLEAN;
BEGIN
  UPDATE scheduled_payrolls
     SET active = FALSE, status = 'cancelled'
   WHERE id = p_payroll_id AND user_id = p_user_id AND active
  RETURNING TRUE INTO v_found;
  RETURN COALESCE(v_found, FALSE);
END;
$$;

GRANT EXECUTE ON FUNCTION public.cancel_payroll(UUID, UUID) TO service_role;
