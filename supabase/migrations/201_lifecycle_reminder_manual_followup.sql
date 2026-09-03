-- Manual follow-up for customers who exhausted both automatic lifecycle
-- reminders (migration 197) and are still genuinely stuck. The automation's
-- own 2-attempt cap never changes -- this adds a human-triggered path on
-- top of it, tracked through the exact same table/webhook so it shows up
-- identically in reporting.

-- 1. Distinguish who triggered each send. Existing rows (all from the
--    automation) default correctly to 'automatic'.
ALTER TABLE public.lifecycle_reminders
  ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'automatic' CHECK (origin IN ('automatic', 'manual'));

-- 2. attempt_number was capped at 2 specifically because the automation
--    itself must never send a 3rd -- that constraint stays enforced in
--    claim_due_lifecycle_reminders' own logic (COALESCE(max,0) < 2), not
--    here. The column-level CHECK just needs widening so a manual send can
--    record attempt 3, 4, etc. 20 is a generous ceiling against a genuine
--    mistake loop, not an expected real value.
ALTER TABLE public.lifecycle_reminders DROP CONSTRAINT IF EXISTS lifecycle_reminders_attempt_number_check;
ALTER TABLE public.lifecycle_reminders ADD CONSTRAINT lifecycle_reminders_attempt_number_check
  CHECK (attempt_number BETWEEN 1 AND 20);

-- 3. Who qualifies: both automatic attempts already sent for a stage, AND
--    still genuinely stuck right now (same real user_pins/user_kyc/
--    transactions checks as claim_due_lifecycle_reminders, just without the
--    time-since-stuck / cooldown clauses -- those only gate the automation's
--    own pacing, not eligibility itself). Never lists someone who quietly
--    resolved on their own, or who's suppressed (bounced/complained).
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

-- 4. Claims a manual send: re-verifies real eligibility at call time (a
--    stale dashboard row is never trusted), records it with origin='manual'
--    and the next attempt_number for that user+stage. Returns nothing if
--    they've already resolved or are suppressed -- the caller must treat an
--    empty result as "nothing to send", not an error.
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
  SELECT i.id, au.email::TEXT, pu.full_name, i.attempt_number
  FROM inserted i JOIN auth.users au ON au.id = p_user_id JOIN public.users pu ON pu.id = p_user_id;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.admin_send_manual_lifecycle_reminder(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.admin_send_manual_lifecycle_reminder(UUID, TEXT) TO service_role;

DO $$ BEGIN
  IF has_table_privilege('authenticated', 'public.lifecycle_reminders', 'SELECT') THEN
    RAISE EXCEPTION 'SECURITY_ASSERTION_FAILED: client can read lifecycle_reminders';
  END IF;
END $$;
