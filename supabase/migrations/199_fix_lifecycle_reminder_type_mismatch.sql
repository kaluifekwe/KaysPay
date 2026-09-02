-- claim_due_lifecycle_reminders still failed after 198's fix: "structure of
-- query does not match function result type". Real cause, found by the same
-- read-only verification call: lifecycle_reminders.attempt_number is
-- SMALLINT (the table's CHECK (attempt_number IN (1,2)) column), but the
-- function declares RETURNS TABLE(..., attempt_number INT) -- smallint and
-- integer aren't the same output type for RETURN QUERY's strict row-type
-- check. Cast it explicitly in the final SELECT. Everything else identical
-- to migration 198.
CREATE OR REPLACE FUNCTION public.claim_due_lifecycle_reminders(p_limit_per_stage INT DEFAULT 3)
RETURNS TABLE(id UUID, user_id UUID, email TEXT, full_name TEXT, stage TEXT, attempt_number INT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  WITH pin_not_set_candidates AS (
    SELECT au.id AS user_id, au.email::TEXT AS email, pu.full_name, 'pin_not_set'::TEXT AS stage,
           (COALESCE(lr.max_attempt, 0) + 1)::INT AS attempt_number
    FROM auth.users au
    JOIN public.users pu ON pu.id = au.id
    LEFT JOIN public.user_pins up ON up.user_id = au.id
    LEFT JOIN public.marketing_suppressions ms ON ms.user_id = au.id
    LEFT JOIN LATERAL (
      SELECT max(attempt_number) AS max_attempt, max(sent_at) AS last_sent_at
      FROM public.lifecycle_reminders WHERE user_id = au.id AND stage = 'pin_not_set'
    ) lr ON true
    WHERE au.email_confirmed_at IS NOT NULL AND au.email IS NOT NULL
      AND up.user_id IS NULL AND ms.user_id IS NULL
      AND COALESCE(lr.max_attempt, 0) < 2
      AND (
        (COALESCE(lr.max_attempt, 0) = 0 AND au.email_confirmed_at <= now() - INTERVAL '48 hours')
        OR (COALESCE(lr.max_attempt, 0) = 1 AND lr.last_sent_at <= now() - INTERVAL '7 days')
      )
    ORDER BY au.email_confirmed_at LIMIT greatest(1, p_limit_per_stage)
  ), kyc_completed_not_funded_candidates AS (
    SELECT au.id, au.email::TEXT, pu.full_name, 'kyc_completed_not_funded'::TEXT,
           (COALESCE(lr.max_attempt, 0) + 1)::INT
    FROM auth.users au
    JOIN public.users pu ON pu.id = au.id
    JOIN public.user_kyc uk ON uk.user_id = au.id AND uk.status = 'verified'
    LEFT JOIN public.marketing_suppressions ms ON ms.user_id = au.id
    LEFT JOIN LATERAL (
      SELECT max(attempt_number) AS max_attempt, max(sent_at) AS last_sent_at
      FROM public.lifecycle_reminders WHERE user_id = au.id AND stage = 'kyc_completed_not_funded'
    ) lr ON true
    WHERE au.email_confirmed_at IS NOT NULL AND au.email IS NOT NULL AND ms.user_id IS NULL
      AND uk.verified_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.transactions t WHERE t.user_id = au.id AND t.type = 'wallet_fund' AND t.status = 'completed')
      AND COALESCE(lr.max_attempt, 0) < 2
      AND (
        (COALESCE(lr.max_attempt, 0) = 0 AND uk.verified_at <= now() - INTERVAL '48 hours')
        OR (COALESCE(lr.max_attempt, 0) = 1 AND lr.last_sent_at <= now() - INTERVAL '7 days')
      )
    ORDER BY uk.verified_at LIMIT greatest(1, p_limit_per_stage)
  ), funded_not_purchased_candidates AS (
    SELECT au.id, au.email::TEXT, pu.full_name, 'funded_not_purchased'::TEXT,
           (COALESCE(lr.max_attempt, 0) + 1)::INT
    FROM auth.users au
    JOIN public.users pu ON pu.id = au.id
    LEFT JOIN public.marketing_suppressions ms ON ms.user_id = au.id
    JOIN LATERAL (
      SELECT min(created_at) AS first_funded_at FROM public.transactions
      WHERE user_id = au.id AND type = 'wallet_fund' AND status = 'completed'
    ) fund ON fund.first_funded_at IS NOT NULL
    LEFT JOIN LATERAL (
      SELECT max(attempt_number) AS max_attempt, max(sent_at) AS last_sent_at
      FROM public.lifecycle_reminders WHERE user_id = au.id AND stage = 'funded_not_purchased'
    ) lr ON true
    WHERE au.email_confirmed_at IS NOT NULL AND au.email IS NOT NULL AND ms.user_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.transactions t WHERE t.user_id = au.id AND t.status = 'completed'
          AND t.type NOT IN ('wallet_fund', 'refund', 'withdrawal', 'card_fund', 'transfer', 'crypto_sell')
      )
      AND COALESCE(lr.max_attempt, 0) < 2
      AND (
        (COALESCE(lr.max_attempt, 0) = 0 AND fund.first_funded_at <= now() - INTERVAL '48 hours')
        OR (COALESCE(lr.max_attempt, 0) = 1 AND lr.last_sent_at <= now() - INTERVAL '7 days')
      )
    ORDER BY fund.first_funded_at LIMIT greatest(1, p_limit_per_stage)
  ), candidates AS (
    SELECT * FROM pin_not_set_candidates
    UNION ALL SELECT * FROM kyc_completed_not_funded_candidates
    UNION ALL SELECT * FROM funded_not_purchased_candidates
  ), inserted AS (
    INSERT INTO public.lifecycle_reminders(user_id, stage, attempt_number)
    SELECT c.user_id, c.stage, c.attempt_number FROM candidates c
    ON CONFLICT (user_id, stage, attempt_number) DO NOTHING
    RETURNING lifecycle_reminders.id, lifecycle_reminders.user_id, lifecycle_reminders.stage, lifecycle_reminders.attempt_number
  )
  SELECT i.id, i.user_id, c.email, c.full_name, i.stage, i.attempt_number::INT
  FROM inserted i JOIN candidates c ON c.user_id = i.user_id AND c.stage = i.stage AND c.attempt_number = i.attempt_number;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.claim_due_lifecycle_reminders(INT) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.claim_due_lifecycle_reminders(INT) TO service_role;
