-- Same class of bug as migration 199: admin_send_manual_lifecycle_reminder's
-- RETURNING gives lifecycle_reminders.attempt_number as SMALLINT, but the
-- function declares RETURNS TABLE(..., attempt_number INT) -- caught by the
-- same read-only claim-then-release verification used before anything real
-- used this path. Cast explicitly in the final SELECT.
CREATE OR REPLACE FUNCTION public.admin_send_manual_lifecycle_reminder(p_user_id UUID, p_stage TEXT)
RETURNS TABLE(id UUID, email TEXT, full_name TEXT, attempt_number INT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
#variable_conflict use_column
DECLARE v_still_stuck BOOLEAN;
BEGIN
  IF p_stage NOT IN ('pin_not_set', 'kyc_completed_not_funded', 'funded_not_purchased') THEN
    RAISE EXCEPTION 'invalid stage';
  END IF;
  IF EXISTS (SELECT 1 FROM public.marketing_suppressions WHERE user_id = p_user_id) THEN
    RETURN;
  END IF;

  IF p_stage = 'pin_not_set' THEN
    SELECT NOT EXISTS (SELECT 1 FROM public.user_pins WHERE user_id = p_user_id) INTO v_still_stuck;
  ELSIF p_stage = 'kyc_completed_not_funded' THEN
    SELECT EXISTS (SELECT 1 FROM public.user_kyc WHERE user_id = p_user_id AND status = 'verified')
       AND NOT EXISTS (SELECT 1 FROM public.transactions WHERE user_id = p_user_id AND type = 'wallet_fund' AND status = 'completed')
    INTO v_still_stuck;
  ELSE
    SELECT EXISTS (SELECT 1 FROM public.transactions WHERE user_id = p_user_id AND type = 'wallet_fund' AND status = 'completed')
       AND NOT EXISTS (
         SELECT 1 FROM public.transactions WHERE user_id = p_user_id AND status = 'completed'
           AND type NOT IN ('wallet_fund', 'refund', 'withdrawal', 'card_fund', 'transfer', 'crypto_sell')
       )
    INTO v_still_stuck;
  END IF;
  IF NOT v_still_stuck THEN RETURN; END IF;

  RETURN QUERY
  WITH next_attempt AS (
    SELECT COALESCE(max(attempt_number), 0) + 1 AS n
    FROM public.lifecycle_reminders WHERE user_id = p_user_id AND stage = p_stage
  ), inserted AS (
    INSERT INTO public.lifecycle_reminders(user_id, stage, attempt_number, origin)
    SELECT p_user_id, p_stage, n, 'manual' FROM next_attempt
    ON CONFLICT (user_id, stage, attempt_number) DO NOTHING
    RETURNING lifecycle_reminders.id, lifecycle_reminders.attempt_number
  )
  SELECT i.id, au.email::TEXT, pu.full_name, i.attempt_number::INT
  FROM inserted i JOIN auth.users au ON au.id = p_user_id JOIN public.users pu ON pu.id = p_user_id;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.admin_send_manual_lifecycle_reminder(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.admin_send_manual_lifecycle_reminder(UUID, TEXT) TO service_role;
