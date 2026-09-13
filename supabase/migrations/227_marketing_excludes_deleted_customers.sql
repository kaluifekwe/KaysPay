-- marketing_segment_members (used when a campaign is approved) and
-- claim_marketing_campaign_batch (used when the worker actually sends) never
-- checked customer_subjects.deleted_at. A deleted customer's real inbox was
-- never at risk -- account deletion overwrites auth.users.email with an
-- undeliverable deleted-<id>@kayspay.invalid placeholder -- but a deleted
-- customer could still be pulled into a segment and would then just fail
-- against that dead address on every retry, wasting Resend calls and
-- muddying delivery stats with an unexplained provider_error. Excluding
-- deleted customers up front makes that explicit instead of incidental.
CREATE OR REPLACE FUNCTION public.marketing_segment_members(p_segment TEXT,p_inactivity_days INT DEFAULT NULL)
RETURNS TABLE(user_id UUID,email TEXT) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,auth AS $$
  WITH latest AS (
    SELECT DISTINCT ON (s.subject_id) s.* FROM public.onboarding_journey_state s
    WHERE s.subject_id IS NOT NULL ORDER BY s.subject_id,s.last_event_at DESC NULLS LAST
  )
  SELECT l.subject_id,au.email::TEXT
  FROM latest l
  JOIN auth.users au ON au.id=l.subject_id AND au.email IS NOT NULL AND au.email_confirmed_at IS NOT NULL
  JOIN public.customer_marketing_preferences p ON p.user_id=l.subject_id AND p.email_opt_in AND p.withdrawn_at IS NULL
  LEFT JOIN public.marketing_suppressions x ON x.user_id=l.subject_id
  LEFT JOIN public.customer_subjects cs ON cs.subject_id=l.subject_id
  WHERE x.user_id IS NULL AND (cs.deleted_at IS NULL) AND CASE p_segment
    WHEN 'registered_not_verified' THEN l.account_created_at IS NOT NULL AND l.email_verified_at IS NULL AND l.account_created_at<now()-interval '1 hour'
    WHEN 'verified_kyc_incomplete' THEN l.email_verified_at IS NOT NULL AND l.kyc_completed_at IS NULL AND l.email_verified_at<now()-interval '24 hours'
    WHEN 'kyc_completed_not_funded' THEN l.kyc_completed_at IS NOT NULL AND l.first_funding_at IS NULL AND l.kyc_completed_at<now()-interval '72 hours'
    WHEN 'funded_not_purchased' THEN l.first_funding_at IS NOT NULL AND l.first_purchase_at IS NULL AND l.first_funding_at<now()-interval '24 hours'
    WHEN 'inactive' THEN l.last_event_at<now()-make_interval(days=>greatest(1,least(coalesce(p_inactivity_days,30),365)))
    ELSE false END;
$$;

CREATE OR REPLACE FUNCTION public.claim_marketing_campaign_batch(p_campaign_id UUID,p_limit INT DEFAULT 20)
RETURNS TABLE(user_id UUID,email TEXT,unsubscribe_token TEXT,subject TEXT,html_body TEXT,text_body TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,auth AS $$
BEGIN
  RETURN QUERY
  WITH campaign AS (
    SELECT c.* FROM public.marketing_campaigns c WHERE c.id=p_campaign_id
      AND c.status IN ('approved','sending') AND (c.scheduled_for IS NULL OR c.scheduled_for<=now()) FOR UPDATE
  ), candidates AS (
    SELECT r.user_id,encode(gen_random_bytes(32),'hex') token
    FROM public.marketing_campaign_recipients r,campaign c
    JOIN auth.users au ON au.id=r.user_id AND au.email IS NOT NULL AND au.email_confirmed_at IS NOT NULL
    JOIN public.customer_marketing_preferences p ON p.user_id=r.user_id AND p.email_opt_in AND p.withdrawn_at IS NULL
    LEFT JOIN public.marketing_suppressions x ON x.user_id=r.user_id
    LEFT JOIN public.customer_subjects cs ON cs.subject_id=r.user_id
    WHERE r.campaign_id=p_campaign_id AND r.status IN ('pending','failed') AND r.attempts<5
      AND x.user_id IS NULL AND cs.deleted_at IS NULL
    ORDER BY r.updated_at FOR UPDATE OF r SKIP LOCKED LIMIT greatest(1,least(p_limit,20))
  ), claimed AS (
    UPDATE public.marketing_campaign_recipients r SET status='sending',attempts=attempts+1,updated_at=now(),
      unsubscribe_token_hash=encode(digest(c.token,'sha256'),'hex')
    FROM candidates c WHERE r.campaign_id=p_campaign_id AND r.user_id=c.user_id
    RETURNING r.user_id,c.token
  ), marked AS (
    UPDATE public.marketing_campaigns SET status='sending',updated_at=now() WHERE id=p_campaign_id AND EXISTS(SELECT 1 FROM claimed) RETURNING id
  )
  SELECT cl.user_id,au.email::TEXT,cl.token,c.subject,c.html_body,c.text_body
  FROM claimed cl JOIN auth.users au ON au.id=cl.user_id CROSS JOIN campaign c;
END;
$$;

-- One-time cleanup: stop retrying against already-deleted customers who are
-- currently sitting in a pending/failed state on an in-flight campaign.
UPDATE public.marketing_campaign_recipients r
SET status='suppressed',updated_at=now()
FROM public.customer_subjects cs
WHERE cs.subject_id=r.user_id AND cs.deleted_at IS NOT NULL AND r.status IN ('pending','failed');
