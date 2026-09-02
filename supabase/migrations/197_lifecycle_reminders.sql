-- Generalizes the one-off KYC reminder (migration 195) into a reusable
-- stage-triggered reminder system for the other onboarding drop-off points
-- identified in admin_onboarding_funnel_report's "stuck" breakdown:
--   pin_not_set              -- verified email, never set a transaction PIN
--   kyc_completed_not_funded -- KYC verified, wallet never funded
--   funded_not_purchased     -- wallet funded, never made a real purchase
-- Deliberately does NOT touch the existing kyc_reminder_sent_at flow (still
-- unverified-KYC users) -- that one is live, tested, and approved; no reason
-- to migrate it into this table too.
--
-- Eligibility is grounded in the same real, server-authoritative tables the
-- KYC reminder already uses (user_pins/user_kyc/wallets/transactions), NOT
-- onboarding_journey_state -- that table has a confirmed linkage gap for
-- real accounts (investigated 2026-09-02), so it's fine for dashboard
-- analytics but not safe as the sole trigger for a real send.

-- 1. Owner-editable pause switch (widen app_settings' key allowlist, same
--    pattern as migration 132's WhatsApp group URL).
ALTER TABLE public.app_settings DROP CONSTRAINT IF EXISTS app_settings_key_check;
ALTER TABLE public.app_settings ADD CONSTRAINT app_settings_key_check
  CHECK (key IN ('support_whatsapp_number', 'support_whatsapp_group_url', 'lifecycle_reminders_enabled'));
INSERT INTO public.app_settings(key, value) VALUES ('lifecycle_reminders_enabled', 'false')
ON CONFLICT (key) DO NOTHING;

-- 2. One claim per (user, stage, attempt) -- the unique constraint IS the
--    concurrency guard (ON CONFLICT DO NOTHING in the claim function below),
--    so no explicit job lock is needed for a function that only ever runs
--    from one 5-minute cron tick.
CREATE TABLE public.lifecycle_reminders (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  stage                TEXT NOT NULL CHECK (stage IN ('pin_not_set', 'kyc_completed_not_funded', 'funded_not_purchased')),
  attempt_number       SMALLINT NOT NULL CHECK (attempt_number IN (1, 2)),
  sent_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  provider_message_id  TEXT,
  delivered_at         TIMESTAMPTZ,
  opened_at            TIMESTAMPTZ,
  clicked_at           TIMESTAMPTZ,
  bounced_at           TIMESTAMPTZ,
  complained_at        TIMESTAMPTZ,
  UNIQUE (user_id, stage, attempt_number)
);
CREATE INDEX idx_lifecycle_reminders_message ON public.lifecycle_reminders(provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE INDEX idx_lifecycle_reminders_user_stage ON public.lifecycle_reminders(user_id, stage);

ALTER TABLE public.lifecycle_reminders ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.lifecycle_reminders FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.lifecycle_reminders TO service_role;

-- 3. Claim due reminders across all three stages. attempt 1 fires 48h after
--    the stage was reached; attempt 2 fires 7 days after attempt 1 IF still
--    stuck (rechecked at claim time, not just elapsed time); nothing beyond
--    attempt 2, ever. p_limit_per_stage keeps each cron tick's send volume
--    small and predictable against the shared 100/day Resend cap (confirmed
--    2026-09-03).
CREATE OR REPLACE FUNCTION public.claim_due_lifecycle_reminders(p_limit_per_stage INT DEFAULT 3)
RETURNS TABLE(id UUID, user_id UUID, email TEXT, full_name TEXT, stage TEXT, attempt_number INT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
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
  SELECT i.id, i.user_id, c.email, c.full_name, i.stage, i.attempt_number
  FROM inserted i JOIN candidates c ON c.user_id = i.user_id AND c.stage = i.stage AND c.attempt_number = i.attempt_number;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.claim_due_lifecycle_reminders(INT) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.claim_due_lifecycle_reminders(INT) TO service_role;

-- 4. Called when the actual Resend send fails, so this exact attempt is
--    retried on the next cron tick instead of being silently lost.
CREATE OR REPLACE FUNCTION public.release_lifecycle_reminder(p_id UUID)
RETURNS VOID LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $$
  DELETE FROM public.lifecycle_reminders WHERE id = p_id;
$$;
REVOKE EXECUTE ON FUNCTION public.release_lifecycle_reminder(UUID) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.release_lifecycle_reminder(UUID) TO service_role;

-- 5. Records the provider_message_id right after a successful send, so the
--    webhook below can match delivery/open/click events back to this row.
CREATE OR REPLACE FUNCTION public.mark_lifecycle_reminder_sent(p_id UUID, p_provider_message_id TEXT)
RETURNS VOID LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $$
  UPDATE public.lifecycle_reminders SET provider_message_id = p_provider_message_id WHERE id = p_id;
$$;
REVOKE EXECUTE ON FUNCTION public.mark_lifecycle_reminder_sent(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.mark_lifecycle_reminder_sent(UUID, TEXT) TO service_role;

-- 6. Extend the existing resend-webhook handler (already deployed, already
--    signature-verified -- see supabase/functions/resend-webhook) to also
--    match lifecycle_reminders by provider_message_id when the message
--    isn't a marketing campaign send. Body is otherwise byte-identical to
--    migration 153's version; only the new block after the campaign check
--    is added.
CREATE OR REPLACE FUNCTION public.record_marketing_email_event(
  p_svix_id TEXT, p_message_id TEXT, p_event_type TEXT, p_event_created_at TIMESTAMPTZ
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_user UUID; v_inserted INT; v_reason TEXT;
BEGIN
  INSERT INTO public.marketing_email_events(svix_id, provider_message_id, event_type, event_created_at)
  VALUES (p_svix_id, p_message_id, p_event_type, p_event_created_at) ON CONFLICT (svix_id) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted = 0 THEN RETURN false; END IF;

  SELECT user_id INTO v_user FROM public.marketing_campaign_recipients WHERE provider_message_id = p_message_id;
  IF v_user IS NOT NULL THEN
    UPDATE public.marketing_campaign_recipients SET
      delivered_at = CASE WHEN p_event_type = 'email.delivered' THEN greatest(COALESCE(delivered_at, p_event_created_at), p_event_created_at) ELSE delivered_at END,
      opened_at = CASE WHEN p_event_type = 'email.opened' THEN greatest(COALESCE(opened_at, p_event_created_at), p_event_created_at) ELSE opened_at END,
      clicked_at = CASE WHEN p_event_type = 'email.clicked' THEN greatest(COALESCE(clicked_at, p_event_created_at), p_event_created_at) ELSE clicked_at END,
      bounced_at = CASE WHEN p_event_type = 'email.bounced' THEN greatest(COALESCE(bounced_at, p_event_created_at), p_event_created_at) ELSE bounced_at END,
      complained_at = CASE WHEN p_event_type = 'email.complained' THEN greatest(COALESCE(complained_at, p_event_created_at), p_event_created_at) ELSE complained_at END,
      delivery_delayed_at = CASE WHEN p_event_type = 'email.delivery_delayed' THEN greatest(COALESCE(delivery_delayed_at, p_event_created_at), p_event_created_at) ELSE delivery_delayed_at END,
      status = CASE WHEN p_event_type IN ('email.bounced', 'email.failed', 'email.suppressed') THEN 'failed' ELSE status END,
      failure_code = CASE WHEN p_event_type = 'email.bounced' THEN 'hard_bounce' WHEN p_event_type = 'email.failed' THEN 'provider_failed' WHEN p_event_type = 'email.suppressed' THEN 'provider_suppressed' ELSE failure_code END,
      updated_at = now()
    WHERE provider_message_id = p_message_id;

    IF p_event_type IN ('email.bounced', 'email.complained', 'email.suppressed') THEN
      v_reason := CASE WHEN p_event_type = 'email.complained' THEN 'complaint' ELSE 'hard_bounce' END;
      INSERT INTO public.marketing_suppressions(user_id, reason, source) VALUES (v_user, v_reason, 'resend_webhook')
      ON CONFLICT (user_id) DO UPDATE SET reason = EXCLUDED.reason, source = EXCLUDED.source, created_at = now();
      UPDATE public.customer_marketing_preferences SET email_opt_in = false, withdrawn_at = now(), updated_at = now() WHERE user_id = v_user;
      UPDATE public.marketing_campaign_recipients SET status = 'suppressed', updated_at = now()
        WHERE user_id = v_user AND status IN ('pending', 'failed');
    END IF;
    RETURN true;
  END IF;

  -- Not a campaign send -- check whether it's a lifecycle reminder instead.
  UPDATE public.lifecycle_reminders SET
    delivered_at = CASE WHEN p_event_type = 'email.delivered' THEN greatest(COALESCE(delivered_at, p_event_created_at), p_event_created_at) ELSE delivered_at END,
    opened_at = CASE WHEN p_event_type = 'email.opened' THEN greatest(COALESCE(opened_at, p_event_created_at), p_event_created_at) ELSE opened_at END,
    clicked_at = CASE WHEN p_event_type = 'email.clicked' THEN greatest(COALESCE(clicked_at, p_event_created_at), p_event_created_at) ELSE clicked_at END,
    bounced_at = CASE WHEN p_event_type = 'email.bounced' THEN greatest(COALESCE(bounced_at, p_event_created_at), p_event_created_at) ELSE bounced_at END,
    complained_at = CASE WHEN p_event_type = 'email.complained' THEN greatest(COALESCE(complained_at, p_event_created_at), p_event_created_at) ELSE complained_at END
  WHERE provider_message_id = p_message_id
  RETURNING user_id INTO v_user;

  IF v_user IS NOT NULL AND p_event_type IN ('email.bounced', 'email.complained') THEN
    v_reason := CASE WHEN p_event_type = 'email.complained' THEN 'complaint' ELSE 'hard_bounce' END;
    INSERT INTO public.marketing_suppressions(user_id, reason, source) VALUES (v_user, v_reason, 'resend_webhook')
    ON CONFLICT (user_id) DO UPDATE SET reason = EXCLUDED.reason, source = EXCLUDED.source, created_at = now();
  END IF;
  RETURN true;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.record_marketing_email_event(TEXT, TEXT, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.record_marketing_email_event(TEXT, TEXT, TEXT, TIMESTAMPTZ) TO service_role;

-- 7. Admin report: how many people are stuck right now (regardless of send
--    cooldown), and how the reminders actually sent are performing.
--    "Resolved" is computed live against the real tables rather than stored,
--    so this never needs a trigger on user_pins/user_kyc/transactions.
CREATE OR REPLACE FUNCTION public.admin_lifecycle_reminder_report()
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
WITH stuck_now AS (
  SELECT jsonb_build_object(
    'pin_not_set', (
      SELECT count(*) FROM auth.users au LEFT JOIN public.user_pins up ON up.user_id = au.id
      WHERE au.email_confirmed_at IS NOT NULL AND up.user_id IS NULL
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

DO $$ BEGIN
  IF has_table_privilege('authenticated', 'public.lifecycle_reminders', 'SELECT') THEN
    RAISE EXCEPTION 'SECURITY_ASSERTION_FAILED: client can read lifecycle_reminders';
  END IF;
END $$;
