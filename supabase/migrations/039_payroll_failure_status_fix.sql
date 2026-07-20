-- Kay's Pay: stop labeling a 100%-failed payroll cycle as "completed"
-- =====================================================================
-- Real incident (2026-07-06): a scheduled payroll's cycle ran, EVERY
-- recipient's airtime send failed with a DNS resolution error reaching
-- VTUAfrica (a transient network blip in the Edge Function's own runtime,
-- not a code bug), and the full amount was correctly refunded — but
-- finish_payroll_run unconditionally set the transaction (and, for a
-- one-time payroll, the mandate itself) to status='completed' regardless
-- of whether any recipient actually got paid. The owner saw "successful"
-- while the recipients received nothing, with the refund being the only
-- real signal (easy to miss) that something had gone wrong.
--
-- Fix: if the refund equals (or exceeds, from any rounding) the original
-- debited amount — meaning literally nobody got paid — mark the
-- transaction 'failed' instead of 'completed'. Same fix flows into
-- advance_payroll_schedule for a one-time payroll's own terminal status.
-- Recurring (weekly/monthly) payrolls keep 'active' regardless, since the
-- mandate itself is still valid and will simply try again next cycle —
-- that per-cycle failure is what the transaction's own status is for.
-- =====================================================================

DROP FUNCTION IF EXISTS public.advance_payroll_schedule(UUID, BOOLEAN);

CREATE OR REPLACE FUNCTION public.advance_payroll_schedule(
  p_payroll_id  UUID,
  p_ran         BOOLEAN,
  p_all_failed  BOOLEAN DEFAULT FALSE
)
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
    -- one-time: done after a real run; if it couldn't run (skipped for
    -- funds) or ran but every recipient failed (refunded in full), label it
    -- 'failed' — a 'completed' label here is exactly what misled a real
    -- user into thinking a payroll worked when recipients got nothing.
    UPDATE scheduled_payrolls
       SET status = CASE WHEN NOT p_ran OR p_all_failed THEN 'failed' ELSE 'completed' END,
           active = FALSE,
           run_count = run_count + (CASE WHEN p_ran THEN 1 ELSE 0 END),
           last_run_at = CASE WHEN p_ran THEN now() ELSE last_run_at END
     WHERE id = p_payroll_id;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.advance_payroll_schedule(UUID, BOOLEAN, BOOLEAN) TO service_role;

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
  v_user_id    UUID;
  v_amount     BIGINT;
  v_all_failed BOOLEAN;
BEGIN
  SELECT user_id INTO v_user_id FROM scheduled_payrolls WHERE id = p_payroll_id;
  IF v_user_id IS NULL THEN RETURN; END IF;

  SELECT amount_ngn INTO v_amount FROM transactions WHERE id = p_tx_id;
  v_all_failed := (v_amount IS NOT NULL AND p_refund >= v_amount);

  IF p_refund > 0 THEN
    UPDATE wallets SET balance = balance + p_refund, updated_at = now() WHERE user_id = v_user_id;
  END IF;

  UPDATE transactions
     SET status = CASE WHEN v_all_failed THEN 'failed' ELSE 'completed' END,
         completed_at = now(),
         metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('refunded_kobo', p_refund, 'result', p_result)
   WHERE id = p_tx_id;

  UPDATE scheduled_payrolls SET result = p_result WHERE id = p_payroll_id;

  PERFORM advance_payroll_schedule(p_payroll_id, TRUE, v_all_failed);
END;
$$;

GRANT EXECUTE ON FUNCTION public.finish_payroll_run(UUID, UUID, BIGINT, JSONB) TO service_role;
