-- Kay's Pay: scheduled payrolls (bulk airtime/data sent on a future date)
-- =====================================================================
-- The user authorizes + is DEBITED when they schedule (automated execution
-- can't prompt for a PIN later). Funds are collected upfront into a single
-- 'payroll' transaction; the payroll-execute cron sends to each recipient on
-- the scheduled date and refunds any recipients that fail.
-- =====================================================================

CREATE TABLE IF NOT EXISTS scheduled_payrolls (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  service_type  TEXT NOT NULL CHECK (service_type IN ('airtime', 'data')),
  recipients    JSONB NOT NULL,       -- [{phone, network, amount_kobo, bundle_id?}]
  total_amount  BIGINT NOT NULL,      -- kobo, already debited at schedule time
  scheduled_for TIMESTAMPTZ NOT NULL,
  status        TEXT NOT NULL DEFAULT 'scheduled'
                  CHECK (status IN ('scheduled', 'processing', 'completed', 'failed', 'cancelled')),
  tx_id         UUID,                 -- the collecting 'payroll' transaction
  result        JSONB,                -- per-recipient outcome after execution
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  executed_at   TIMESTAMPTZ
);

ALTER TABLE scheduled_payrolls ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own scheduled payrolls" ON scheduled_payrolls;
CREATE POLICY "Users can view own scheduled payrolls" ON scheduled_payrolls
  FOR SELECT USING (auth.uid() = user_id);

REVOKE INSERT, UPDATE, DELETE ON scheduled_payrolls FROM anon, authenticated;

CREATE INDEX IF NOT EXISTS idx_scheduled_payrolls_due
  ON scheduled_payrolls (scheduled_for) WHERE status = 'scheduled';

-- Debit the wallet for the full payroll now + create the schedule + a single
-- collecting transaction. Atomic + balance-checked, same locking as
-- debit_for_service.
CREATE OR REPLACE FUNCTION public.schedule_payroll(
  p_user_id       UUID,
  p_service_type  TEXT,
  p_recipients    JSONB,
  p_total         BIGINT,   -- kobo
  p_scheduled_for TIMESTAMPTZ
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_balance    BIGINT;
  v_tx_id      UUID;
  v_payroll_id UUID;
BEGIN
  IF p_total IS NULL OR p_total <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT';
  END IF;
  IF p_scheduled_for <= now() THEN
    RAISE EXCEPTION 'INVALID_SCHEDULE_TIME';
  END IF;

  SELECT balance INTO v_balance FROM wallets WHERE user_id = p_user_id FOR UPDATE;
  IF v_balance IS NULL THEN
    RAISE EXCEPTION 'WALLET_NOT_FOUND';
  END IF;
  IF v_balance < p_total THEN
    RAISE EXCEPTION 'INSUFFICIENT_FUNDS';
  END IF;

  UPDATE wallets SET balance = balance - p_total, updated_at = now() WHERE user_id = p_user_id;

  INSERT INTO transactions (user_id, type, amount_ngn, status, metadata)
  VALUES (p_user_id, 'payroll', p_total, 'pending',
          jsonb_build_object('service', p_service_type, 'recipient_count', jsonb_array_length(p_recipients),
                             'scheduled_for', p_scheduled_for))
  RETURNING id INTO v_tx_id;

  INSERT INTO scheduled_payrolls (user_id, service_type, recipients, total_amount, scheduled_for, tx_id)
  VALUES (p_user_id, p_service_type, p_recipients, p_total, p_scheduled_for, v_tx_id)
  RETURNING id INTO v_payroll_id;

  RETURN v_payroll_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.schedule_payroll(UUID, TEXT, JSONB, BIGINT, TIMESTAMPTZ) TO service_role;

-- Refund the value of recipients that failed during execution, back to the
-- user's wallet. Called once per payroll by the executor with the failed sum.
CREATE OR REPLACE FUNCTION public.refund_payroll(
  p_payroll_id UUID,
  p_amount     BIGINT,   -- kobo to return (0 if all succeeded)
  p_status     TEXT,     -- 'completed' or 'failed'
  p_result     JSONB
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID;
  v_tx_id   UUID;
BEGIN
  SELECT user_id, tx_id INTO v_user_id, v_tx_id
    FROM scheduled_payrolls WHERE id = p_payroll_id AND status = 'processing' FOR UPDATE;
  IF v_user_id IS NULL THEN
    RETURN; -- already settled / not found
  END IF;

  IF p_amount > 0 THEN
    UPDATE wallets SET balance = balance + p_amount, updated_at = now() WHERE user_id = v_user_id;
  END IF;

  UPDATE scheduled_payrolls
     SET status = p_status, result = p_result, executed_at = now()
   WHERE id = p_payroll_id;

  UPDATE transactions
     SET status = CASE WHEN p_status = 'failed' THEN 'failed' ELSE 'completed' END,
         completed_at = now(),
         metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('refunded_kobo', p_amount)
   WHERE id = v_tx_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.refund_payroll(UUID, BIGINT, TEXT, JSONB) TO service_role;

-- Claim due payrolls for execution (status scheduled -> processing) so the
-- cron never double-runs one. Returns the claimed rows.
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
      WHERE status = 'scheduled' AND scheduled_for <= now()
      ORDER BY scheduled_for
      LIMIT p_limit
      FOR UPDATE SKIP LOCKED
   )
  RETURNING *;
END;
$$;

GRANT EXECUTE ON FUNCTION public.claim_due_payrolls(INT) TO service_role;
