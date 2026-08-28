-- Phase 5: consent-first onboarding recovery campaigns.
-- Existing customers are deliberately NOT opted in. A missing preference row
-- is treated as no consent by every audience query.

CREATE TABLE public.customer_marketing_preferences (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email_opt_in BOOLEAN NOT NULL DEFAULT false,
  consent_source TEXT CHECK (consent_source IS NULL OR consent_source IN ('registration','settings','support')),
  consented_at TIMESTAMPTZ,
  withdrawn_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((email_opt_in AND consented_at IS NOT NULL AND withdrawn_at IS NULL) OR NOT email_opt_in)
);

CREATE TABLE public.marketing_suppressions (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK (reason IN ('unsubscribed','complaint','hard_bounce','admin')),
  source TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.marketing_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 3 AND 120),
  subject TEXT NOT NULL CHECK (length(btrim(subject)) BETWEEN 3 AND 150),
  html_body TEXT NOT NULL CHECK (length(html_body) BETWEEN 10 AND 50000),
  text_body TEXT NOT NULL CHECK (length(text_body) BETWEEN 10 AND 20000),
  segment TEXT NOT NULL CHECK (segment IN (
    'registered_not_verified','verified_kyc_incomplete','kyc_completed_not_funded',
    'funded_not_purchased','inactive'
  )),
  inactivity_days SMALLINT CHECK (inactivity_days IS NULL OR inactivity_days BETWEEN 1 AND 365),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','sending','sent','paused','cancelled','failed')),
  scheduled_for TIMESTAMPTZ,
  created_by UUID NOT NULL REFERENCES auth.users(id),
  approved_by UUID REFERENCES auth.users(id),
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (segment='inactive' OR inactivity_days IS NULL),
  CHECK (segment<>'inactive' OR inactivity_days IS NOT NULL),
  CHECK ((approved_by IS NULL AND approved_at IS NULL) OR (approved_by IS NOT NULL AND approved_at IS NOT NULL))
);

CREATE TABLE public.marketing_campaign_recipients (
  campaign_id UUID NOT NULL REFERENCES public.marketing_campaigns(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','failed','suppressed')),
  provider_message_id TEXT,
  failure_code TEXT,
  unsubscribe_token_hash TEXT,
  attempts SMALLINT NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  sent_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id,user_id)
);

CREATE INDEX idx_marketing_campaigns_created ON public.marketing_campaigns(created_at DESC);
CREATE INDEX idx_marketing_recipients_dispatch ON public.marketing_campaign_recipients(campaign_id,status,updated_at);

ALTER TABLE public.customer_marketing_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_suppressions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_campaign_recipients ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.customer_marketing_preferences,public.marketing_suppressions,public.marketing_campaigns,public.marketing_campaign_recipients FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.customer_marketing_preferences,public.marketing_suppressions,public.marketing_campaigns,public.marketing_campaign_recipients TO service_role;

CREATE FUNCTION public.set_my_email_marketing_consent(p_opt_in BOOLEAN,p_source TEXT DEFAULT 'settings') RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_source NOT IN ('registration','settings') THEN RAISE EXCEPTION 'INVALID_SOURCE'; END IF;
  INSERT INTO public.customer_marketing_preferences(user_id,email_opt_in,consent_source,consented_at,withdrawn_at)
  VALUES(auth.uid(),p_opt_in,p_source,CASE WHEN p_opt_in THEN now() END,CASE WHEN p_opt_in THEN NULL ELSE now() END)
  ON CONFLICT(user_id) DO UPDATE SET
    email_opt_in=EXCLUDED.email_opt_in,consent_source=EXCLUDED.consent_source,
    consented_at=CASE WHEN EXCLUDED.email_opt_in THEN now() ELSE customer_marketing_preferences.consented_at END,
    withdrawn_at=CASE WHEN EXCLUDED.email_opt_in THEN NULL ELSE now() END,updated_at=now();
  IF NOT p_opt_in THEN
    INSERT INTO public.marketing_suppressions(user_id,reason,source) VALUES(auth.uid(),'unsubscribed','customer_settings')
    ON CONFLICT(user_id) DO UPDATE SET reason='unsubscribed',source='customer_settings',created_at=now();
  ELSE
    DELETE FROM public.marketing_suppressions WHERE user_id=auth.uid() AND reason='unsubscribed';
  END IF;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.set_my_email_marketing_consent(BOOLEAN,TEXT) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.set_my_email_marketing_consent(BOOLEAN,TEXT) TO authenticated;

CREATE FUNCTION public.marketing_segment_members(p_segment TEXT,p_inactivity_days INT DEFAULT NULL)
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
  WHERE x.user_id IS NULL AND CASE p_segment
    WHEN 'registered_not_verified' THEN l.account_created_at IS NOT NULL AND l.email_verified_at IS NULL AND l.account_created_at<now()-interval '1 hour'
    WHEN 'verified_kyc_incomplete' THEN l.email_verified_at IS NOT NULL AND l.kyc_completed_at IS NULL AND l.email_verified_at<now()-interval '24 hours'
    WHEN 'kyc_completed_not_funded' THEN l.kyc_completed_at IS NOT NULL AND l.first_funding_at IS NULL AND l.kyc_completed_at<now()-interval '72 hours'
    WHEN 'funded_not_purchased' THEN l.first_funding_at IS NOT NULL AND l.first_purchase_at IS NULL AND l.first_funding_at<now()-interval '24 hours'
    WHEN 'inactive' THEN l.last_event_at<now()-make_interval(days=>greatest(1,least(coalesce(p_inactivity_days,30),365)))
    ELSE false END;
$$;
REVOKE EXECUTE ON FUNCTION public.marketing_segment_members(TEXT,INT) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.marketing_segment_members(TEXT,INT) TO service_role;

CREATE FUNCTION public.approve_marketing_campaign(p_campaign_id UUID,p_admin_id UUID) RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_campaign public.marketing_campaigns%ROWTYPE; v_count INT;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.admin_users WHERE user_id=p_admin_id AND role='super_admin' AND disabled_at IS NULL) THEN
    RAISE EXCEPTION 'SUPER_ADMIN_REQUIRED';
  END IF;
  SELECT * INTO v_campaign FROM public.marketing_campaigns WHERE id=p_campaign_id FOR UPDATE;
  IF NOT FOUND OR v_campaign.status<>'draft' THEN RAISE EXCEPTION 'CAMPAIGN_NOT_DRAFT'; END IF;
  INSERT INTO public.marketing_campaign_recipients(campaign_id,user_id)
  SELECT p_campaign_id,m.user_id FROM public.marketing_segment_members(v_campaign.segment,v_campaign.inactivity_days) m
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  UPDATE public.marketing_campaigns SET status='approved',approved_by=p_admin_id,approved_at=now(),updated_at=now() WHERE id=p_campaign_id;
  RETURN v_count;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.approve_marketing_campaign(UUID,UUID) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.approve_marketing_campaign(UUID,UUID) TO service_role;

CREATE FUNCTION public.claim_marketing_campaign_batch(p_campaign_id UUID,p_limit INT DEFAULT 20)
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
    WHERE r.campaign_id=p_campaign_id AND r.status IN ('pending','failed') AND r.attempts<5 AND x.user_id IS NULL
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
REVOKE EXECUTE ON FUNCTION public.claim_marketing_campaign_batch(UUID,INT) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_marketing_campaign_batch(UUID,INT) TO service_role;

CREATE FUNCTION public.unsubscribe_marketing_by_token(p_token TEXT) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_user UUID;
BEGIN
  IF p_token IS NULL OR p_token !~ '^[0-9a-f]{64}$' THEN RETURN false; END IF;
  SELECT user_id INTO v_user FROM public.marketing_campaign_recipients
  WHERE unsubscribe_token_hash=encode(digest(p_token,'sha256'),'hex') LIMIT 1;
  IF v_user IS NULL THEN RETURN false; END IF;
  INSERT INTO public.marketing_suppressions(user_id,reason,source) VALUES(v_user,'unsubscribed','email_link')
  ON CONFLICT(user_id) DO UPDATE SET reason='unsubscribed',source='email_link',created_at=now();
  INSERT INTO public.customer_marketing_preferences(user_id,email_opt_in,consent_source,withdrawn_at)
  VALUES(v_user,false,'settings',now()) ON CONFLICT(user_id) DO UPDATE SET email_opt_in=false,withdrawn_at=now(),updated_at=now();
  UPDATE public.marketing_campaign_recipients SET status='suppressed',updated_at=now()
  WHERE user_id=v_user AND status IN ('pending','failed');
  RETURN true;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.unsubscribe_marketing_by_token(TEXT) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.unsubscribe_marketing_by_token(TEXT) TO service_role;

DO $$ BEGIN
  IF has_table_privilege('authenticated','public.marketing_campaigns','SELECT') THEN
    RAISE EXCEPTION 'SECURITY_ASSERTION_FAILED: client can read campaigns directly';
  END IF;
END $$;
