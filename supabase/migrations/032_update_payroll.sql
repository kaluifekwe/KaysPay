-- Kay's Pay: edit an active payroll's recipients
-- =====================================================================
-- Lets the owner add/remove recipients on an active payroll. Changes the
-- per-cycle total (future debits), so the edge function re-derives the total
-- server-side and requires a fresh PIN step-up. Owner-scoped.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.update_payroll(
  p_user_id     UUID,
  p_payroll_id  UUID,
  p_recipients  JSONB,
  p_total       BIGINT
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_found BOOLEAN;
BEGIN
  IF p_total IS NULL OR p_total <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT';
  END IF;

  UPDATE scheduled_payrolls
     SET recipients = p_recipients, total_amount = p_total
   WHERE id = p_payroll_id AND user_id = p_user_id AND active AND status = 'active'
  RETURNING TRUE INTO v_found;

  RETURN COALESCE(v_found, FALSE);
END;
$$;

GRANT EXECUTE ON FUNCTION public.update_payroll(UUID, UUID, JSONB, BIGINT) TO service_role;
