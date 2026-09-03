-- Consolidates the old one-shot KYC reminder (migration 195) into the
-- lifecycle_reminders framework as a 4th stage, 'kyc_not_started'. The old
-- system sent exactly one email, 48h after account creation, to ANYONE
-- unverified -- including people who hadn't even set a PIN yet. That
-- overlapped with the new pin_not_set stage and gave the same underlying
-- population a weaker experience (no retry, no tracking, no manual
-- follow-up) than the other 3 stages. Retiring it in favor of one
-- consistent mechanism: 2 attempts, real open/click tracking, manual
-- follow-up available.
--
-- Scoped to accounts that HAVE a PIN (the pin_not_set stage already owns
-- "hasn't finished registration" -- this stage owns "finished registration,
-- never started KYC", not both at once for the same person).
--
-- claim_due_kyc_reminders/unmark_kyc_reminder_sent (migration 195) and the
-- kyc_reminder_sent_at column are left in place, just no longer called --
-- a conservative choice over dropping them, since kyc_reminder_sent_at is
-- the only record of who the old system already emailed once.

ALTER TABLE public.lifecycle_reminders DROP CONSTRAINT IF EXISTS lifecycle_reminders_stage_check;
ALTER TABLE public.lifecycle_reminders ADD CONSTRAINT lifecycle_reminders_stage_check
  CHECK (stage IN ('pin_not_set', 'kyc_not_started', 'kyc_completed_not_funded', 'funded_not_purchased'));

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
  ), kyc_not_started_candidates AS (
    SELECT au.id, au.email::TEXT, pu.full_name, 'kyc_not_started'::TEXT,
           (COALESCE(lr.max_attempt, 0) + 1)::INT
    FROM auth.users au
    JOIN public.users pu ON pu.id = au.id
    JOIN public.user_pins up ON up.user_id = au.id
    LEFT JOIN public.user_kyc uk ON uk.user_id = au.id
    LEFT JOIN public.marketing_suppressions ms ON ms.user_id = au.id
    LEFT JOIN LATERAL (
      SELECT max(attempt_number) AS max_attempt, max(sent_at) AS last_sent_at
      FROM public.lifecycle_reminders WHERE user_id = au.id AND stage = 'kyc_not_started'
    ) lr ON true
    WHERE au.email_confirmed_at IS NOT NULL AND au.email IS NOT NULL AND ms.user_id IS NULL
      AND COALESCE(uk.status, 'unverified') <> 'verified'
      AND COALESCE(lr.max_attempt, 0) < 2
      AND (
        (COALESCE(lr.max_attempt, 0) = 0 AND pu.created_at <= now() - INTERVAL '48 hours')
        OR (COALESCE(lr.max_attempt, 0) = 1 AND lr.last_sent_at <= now() - INTERVAL '7 days')
      )
    ORDER BY pu.created_at LIMIT greatest(1, p_limit_per_stage)
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
    UNION ALL SELECT * FROM kyc_not_started_candidates
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

CREATE OR REPLACE FUNCTION public.admin_lifecycle_reminder_report()
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
WITH stuck_now AS (
  SELECT jsonb_build_object(
    'pin_not_set', (
      SELECT count(*) FROM auth.users au LEFT JOIN public.user_pins up ON up.user_id = au.id
      WHERE au.email_confirmed_at IS NOT NULL AND up.user_id IS NULL
    ),
    'kyc_not_started', (
      SELECT count(*) FROM auth.users au
      JOIN public.user_pins up ON up.user_id = au.id
      LEFT JOIN public.user_kyc uk ON uk.user_id = au.id
      WHERE au.email_confirmed_at IS NOT NULL AND COALESCE(uk.status, 'unverified') <> 'verified'
    ),
    'kyc_completed_not_funded', (
      SELECT count(*) FROM public.user_kyc uk
      WHERE uk.status = 'verified'
        AND NOT EXISTS (SELECT 1 FROM public.transactions t WHERE t.user_id = uk.user_id AND t.type = 'wallet_fund' AND t.status = 'completed')
    ),
    'funded_not_purchased', (
      SELECT count(DISTINCT t.user_id) FROM public.transactions t
      WHERE t.type = 'wallet_fund' AND t.status = 'completed'
        AND NOT EXISTS (
          SELECT 1 FROM public.transactions p WHERE p.user_id = t.user_id AND p.status = 'completed'
            AND p.type NOT IN ('wallet_fund', 'refund', 'withdrawal', 'card_fund', 'transfer', 'crypto_sell')
        )
    )
  ) AS value
), sent_stats AS (
  SELECT stage, count(*) sent, count(*) FILTER (WHERE opened_at IS NOT NULL) opened,
    count(*) FILTER (WHERE clicked_at IS NOT NULL) clicked,
    count(*) FILTER (WHERE bounced_at IS NOT NULL OR complained_at IS NOT NULL) failed,
    count(*) FILTER (
      WHERE (stage = 'pin_not_set' AND EXISTS (SELECT 1 FROM public.user_pins up WHERE up.user_id = lifecycle_reminders.user_id))
         OR (stage = 'kyc_not_started' AND EXISTS (SELECT 1 FROM public.user_kyc uk WHERE uk.user_id = lifecycle_reminders.user_id AND uk.status = 'verified'))
         OR (stage = 'kyc_completed_not_funded' AND EXISTS (SELECT 1 FROM public.transactions t WHERE t.user_id = lifecycle_reminders.user_id AND t.type = 'wallet_fund' AND t.status = 'completed' AND t.created_at > lifecycle_reminders.sent_at))
         OR (stage = 'funded_not_purchased' AND EXISTS (SELECT 1 FROM public.transactions t WHERE t.user_id = lifecycle_reminders.user_id AND t.status = 'completed' AND t.type NOT IN ('wallet_fund', 'refund', 'withdrawal', 'card_fund', 'transfer', 'crypto_sell') AND t.created_at > lifecycle_reminders.sent_at))
    ) resolved
  FROM public.lifecycle_reminders GROUP BY stage
)
SELECT jsonb_build_object(
  'enabled', (SELECT value = 'true' FROM public.app_settings WHERE key = 'lifecycle_reminders_enabled'),
  'stuck_now', (SELECT value FROM stuck_now),
  'sent_stats', COALESCE((SELECT jsonb_object_agg(stage, to_jsonb(s) - 'stage') FROM sent_stats s), '{}'::jsonb)
);
$$;
REVOKE EXECUTE ON FUNCTION public.admin_lifecycle_reminder_report() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.admin_lifecycle_reminder_report() TO service_role;

CREATE OR REPLACE FUNCTION public.admin_list_lifecycle_followup_candidates()
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
WITH pin_not_set_candidates AS (
  SELECT au.id AS user_id, au.email::TEXT AS email, pu.full_name, 'pin_not_set'::TEXT AS stage
  FROM auth.users au
  JOIN public.users pu ON pu.id = au.id
  LEFT JOIN public.user_pins up ON up.user_id = au.id
  LEFT JOIN public.marketing_suppressions ms ON ms.user_id = au.id
  WHERE up.user_id IS NULL AND ms.user_id IS NULL
    AND EXISTS (SELECT 1 FROM public.lifecycle_reminders lr WHERE lr.user_id = au.id AND lr.stage = 'pin_not_set' AND lr.attempt_number = 1 AND lr.origin = 'automatic')
    AND EXISTS (SELECT 1 FROM public.lifecycle_reminders lr WHERE lr.user_id = au.id AND lr.stage = 'pin_not_set' AND lr.attempt_number = 2 AND lr.origin = 'automatic')
), kyc_not_started_candidates AS (
  SELECT au.id, au.email::TEXT, pu.full_name, 'kyc_not_started'::TEXT
  FROM auth.users au
  JOIN public.users pu ON pu.id = au.id
  JOIN public.user_pins up ON up.user_id = au.id
  LEFT JOIN public.user_kyc uk ON uk.user_id = au.id
  LEFT JOIN public.marketing_suppressions ms ON ms.user_id = au.id
  WHERE ms.user_id IS NULL AND COALESCE(uk.status, 'unverified') <> 'verified'
    AND EXISTS (SELECT 1 FROM public.lifecycle_reminders lr WHERE lr.user_id = au.id AND lr.stage = 'kyc_not_started' AND lr.attempt_number = 1 AND lr.origin = 'automatic')
    AND EXISTS (SELECT 1 FROM public.lifecycle_reminders lr WHERE lr.user_id = au.id AND lr.stage = 'kyc_not_started' AND lr.attempt_number = 2 AND lr.origin = 'automatic')
), kyc_completed_not_funded_candidates AS (
  SELECT au.id, au.email::TEXT, pu.full_name, 'kyc_completed_not_funded'::TEXT
  FROM auth.users au
  JOIN public.users pu ON pu.id = au.id
  JOIN public.user_kyc uk ON uk.user_id = au.id AND uk.status = 'verified'
  LEFT JOIN public.marketing_suppressions ms ON ms.user_id = au.id
  WHERE ms.user_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM public.transactions t WHERE t.user_id = au.id AND t.type = 'wallet_fund' AND t.status = 'completed')
    AND EXISTS (SELECT 1 FROM public.lifecycle_reminders lr WHERE lr.user_id = au.id AND lr.stage = 'kyc_completed_not_funded' AND lr.attempt_number = 1 AND lr.origin = 'automatic')
    AND EXISTS (SELECT 1 FROM public.lifecycle_reminders lr WHERE lr.user_id = au.id AND lr.stage = 'kyc_completed_not_funded' AND lr.attempt_number = 2 AND lr.origin = 'automatic')
), funded_not_purchased_candidates AS (
  SELECT au.id, au.email::TEXT, pu.full_name, 'funded_not_purchased'::TEXT
  FROM auth.users au
  JOIN public.users pu ON pu.id = au.id
  LEFT JOIN public.marketing_suppressions ms ON ms.user_id = au.id
  WHERE ms.user_id IS NULL
    AND EXISTS (SELECT 1 FROM public.transactions t WHERE t.user_id = au.id AND t.type = 'wallet_fund' AND t.status = 'completed')
    AND NOT EXISTS (
      SELECT 1 FROM public.transactions t WHERE t.user_id = au.id AND t.status = 'completed'
        AND t.type NOT IN ('wallet_fund', 'refund', 'withdrawal', 'card_fund', 'transfer', 'crypto_sell')
    )
    AND EXISTS (SELECT 1 FROM public.lifecycle_reminders lr WHERE lr.user_id = au.id AND lr.stage = 'funded_not_purchased' AND lr.attempt_number = 1 AND lr.origin = 'automatic')
    AND EXISTS (SELECT 1 FROM public.lifecycle_reminders lr WHERE lr.user_id = au.id AND lr.stage = 'funded_not_purchased' AND lr.attempt_number = 2 AND lr.origin = 'automatic')
), candidates AS (
  SELECT * FROM pin_not_set_candidates
  UNION ALL SELECT * FROM kyc_not_started_candidates
  UNION ALL SELECT * FROM kyc_completed_not_funded_candidates
  UNION ALL SELECT * FROM funded_not_purchased_candidates
), enriched AS (
  SELECT c.user_id, c.email, c.full_name, c.stage,
    (SELECT max(sent_at) FROM public.lifecycle_reminders lr WHERE lr.user_id = c.user_id AND lr.stage = c.stage) AS last_sent_at,
    (SELECT max(opened_at) FROM public.lifecycle_reminders lr WHERE lr.user_id = c.user_id AND lr.stage = c.stage) AS last_opened_at,
    (SELECT max(clicked_at) FROM public.lifecycle_reminders lr WHERE lr.user_id = c.user_id AND lr.stage = c.stage) AS last_clicked_at,
    (SELECT count(*) FROM public.lifecycle_reminders lr WHERE lr.user_id = c.user_id AND lr.stage = c.stage AND lr.origin = 'manual') AS manual_sends_count
  FROM candidates c
)
SELECT COALESCE(jsonb_agg(to_jsonb(enriched) ORDER BY last_sent_at ASC), '[]'::jsonb) FROM enriched;
$$;
REVOKE EXECUTE ON FUNCTION public.admin_list_lifecycle_followup_candidates() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.admin_list_lifecycle_followup_candidates() TO service_role;

CREATE OR REPLACE FUNCTION public.admin_send_manual_lifecycle_reminder(p_user_id UUID, p_stage TEXT)
RETURNS TABLE(id UUID, email TEXT, full_name TEXT, attempt_number INT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
#variable_conflict use_column
DECLARE v_still_stuck BOOLEAN;
BEGIN
  IF p_stage NOT IN ('pin_not_set', 'kyc_not_started', 'kyc_completed_not_funded', 'funded_not_purchased') THEN
    RAISE EXCEPTION 'invalid stage';
  END IF;
  IF EXISTS (SELECT 1 FROM public.marketing_suppressions WHERE user_id = p_user_id) THEN
    RETURN;
  END IF;

  IF p_stage = 'pin_not_set' THEN
    SELECT NOT EXISTS (SELECT 1 FROM public.user_pins WHERE user_id = p_user_id) INTO v_still_stuck;
  ELSIF p_stage = 'kyc_not_started' THEN
    SELECT EXISTS (SELECT 1 FROM public.user_pins WHERE user_id = p_user_id)
       AND COALESCE((SELECT status FROM public.user_kyc WHERE user_id = p_user_id), 'unverified') <> 'verified'
    INTO v_still_stuck;
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
