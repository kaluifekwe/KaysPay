-- Duplicate-safe campaign recovery and privacy-minimal Resend event tracking.
ALTER TABLE public.marketing_campaign_recipients
  ADD COLUMN IF NOT EXISTS unsubscribe_token UUID DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS opened_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS clicked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS complained_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS delivery_delayed_at TIMESTAMPTZ;
UPDATE public.marketing_campaign_recipients SET unsubscribe_token=gen_random_uuid() WHERE unsubscribe_token IS NULL;
ALTER TABLE public.marketing_campaign_recipients ALTER COLUMN unsubscribe_token SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_marketing_recipient_unsubscribe_token
  ON public.marketing_campaign_recipients(unsubscribe_token);
CREATE UNIQUE INDEX IF NOT EXISTS idx_marketing_recipient_provider_message
  ON public.marketing_campaign_recipients(provider_message_id) WHERE provider_message_id IS NOT NULL;

CREATE TABLE public.marketing_email_events (
  svix_id TEXT PRIMARY KEY CHECK (length(svix_id) BETWEEN 8 AND 128),
  provider_message_id TEXT NOT NULL CHECK (length(provider_message_id) BETWEEN 8 AND 128),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'email.sent','email.delivered','email.delivery_delayed','email.bounced',
    'email.failed','email.suppressed','email.complained','email.opened','email.clicked'
  )),
  event_created_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_marketing_email_events_message ON public.marketing_email_events(provider_message_id,event_created_at DESC);
ALTER TABLE public.marketing_email_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.marketing_email_events FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,DELETE ON public.marketing_email_events TO service_role;

CREATE OR REPLACE FUNCTION public.claim_marketing_campaign_batch(p_campaign_id UUID,p_limit INT DEFAULT 20)
RETURNS TABLE(user_id UUID,email TEXT,unsubscribe_token TEXT,subject TEXT,html_body TEXT,text_body TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,auth AS $$
BEGIN
  -- An unknown send older than Resend's idempotency window is never retried automatically.
  UPDATE public.marketing_campaign_recipients SET status='failed',attempts=5,
    failure_code='delivery_outcome_unknown',updated_at=now()
  WHERE campaign_id=p_campaign_id AND status='sending' AND updated_at<now()-interval '23 hours';

  RETURN QUERY
  WITH campaign AS (
    SELECT c.* FROM public.marketing_campaigns c WHERE c.id=p_campaign_id
      AND c.status IN ('approved','sending') AND (c.scheduled_for IS NULL OR c.scheduled_for<=now()) FOR UPDATE
  ), candidates AS (
    SELECT r.user_id
    FROM public.marketing_campaign_recipients r CROSS JOIN campaign c
    JOIN auth.users au ON au.id=r.user_id AND au.email IS NOT NULL AND au.email_confirmed_at IS NOT NULL
    JOIN public.customer_marketing_preferences p ON p.user_id=r.user_id AND p.email_opt_in AND p.withdrawn_at IS NULL
    LEFT JOIN public.marketing_suppressions x ON x.user_id=r.user_id
    WHERE r.campaign_id=p_campaign_id AND r.attempts<5 AND x.user_id IS NULL
      AND (r.status IN ('pending','failed') OR
        (r.status='sending' AND r.updated_at<now()-interval '15 minutes' AND r.updated_at>=now()-interval '23 hours'))
    ORDER BY r.updated_at FOR UPDATE OF r SKIP LOCKED LIMIT greatest(1,least(p_limit,20))
  ), claimed AS (
    UPDATE public.marketing_campaign_recipients r SET status='sending',attempts=attempts+1,updated_at=now()
    FROM candidates c WHERE r.campaign_id=p_campaign_id AND r.user_id=c.user_id
    RETURNING r.user_id,r.unsubscribe_token
  ), marked AS (
    UPDATE public.marketing_campaigns SET status='sending',updated_at=now()
    WHERE id=p_campaign_id AND EXISTS(SELECT 1 FROM claimed) RETURNING id
  )
  SELECT cl.user_id,au.email::TEXT,cl.unsubscribe_token::TEXT,c.subject,c.html_body,c.text_body
  FROM claimed cl JOIN auth.users au ON au.id=cl.user_id CROSS JOIN campaign c;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.claim_marketing_campaign_batch(UUID,INT) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_marketing_campaign_batch(UUID,INT) TO service_role;

CREATE OR REPLACE FUNCTION public.unsubscribe_marketing_by_token(p_token TEXT) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_user UUID; v_uuid UUID;
BEGIN
  BEGIN v_uuid:=p_token::UUID; EXCEPTION WHEN invalid_text_representation THEN v_uuid:=NULL; END;
  IF v_uuid IS NOT NULL THEN
    SELECT user_id INTO v_user FROM public.marketing_campaign_recipients WHERE unsubscribe_token=v_uuid LIMIT 1;
  ELSIF p_token ~ '^[0-9a-f]{64}$' THEN
    SELECT user_id INTO v_user FROM public.marketing_campaign_recipients
      WHERE unsubscribe_token_hash=encode(digest(p_token,'sha256'),'hex') LIMIT 1;
  END IF;
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

CREATE OR REPLACE FUNCTION public.record_marketing_email_event(
  p_svix_id TEXT,p_message_id TEXT,p_event_type TEXT,p_event_created_at TIMESTAMPTZ
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_user UUID; v_inserted INT; v_reason TEXT;
BEGIN
  INSERT INTO public.marketing_email_events(svix_id,provider_message_id,event_type,event_created_at)
  VALUES(p_svix_id,p_message_id,p_event_type,p_event_created_at) ON CONFLICT(svix_id) DO NOTHING;
  GET DIAGNOSTICS v_inserted=ROW_COUNT;
  IF v_inserted=0 THEN RETURN false; END IF;
  SELECT user_id INTO v_user FROM public.marketing_campaign_recipients WHERE provider_message_id=p_message_id;
  IF v_user IS NULL THEN RETURN true; END IF;

  UPDATE public.marketing_campaign_recipients SET
    delivered_at=CASE WHEN p_event_type='email.delivered' THEN greatest(COALESCE(delivered_at,p_event_created_at),p_event_created_at) ELSE delivered_at END,
    opened_at=CASE WHEN p_event_type='email.opened' THEN greatest(COALESCE(opened_at,p_event_created_at),p_event_created_at) ELSE opened_at END,
    clicked_at=CASE WHEN p_event_type='email.clicked' THEN greatest(COALESCE(clicked_at,p_event_created_at),p_event_created_at) ELSE clicked_at END,
    bounced_at=CASE WHEN p_event_type='email.bounced' THEN greatest(COALESCE(bounced_at,p_event_created_at),p_event_created_at) ELSE bounced_at END,
    complained_at=CASE WHEN p_event_type='email.complained' THEN greatest(COALESCE(complained_at,p_event_created_at),p_event_created_at) ELSE complained_at END,
    delivery_delayed_at=CASE WHEN p_event_type='email.delivery_delayed' THEN greatest(COALESCE(delivery_delayed_at,p_event_created_at),p_event_created_at) ELSE delivery_delayed_at END,
    status=CASE WHEN p_event_type IN ('email.bounced','email.failed','email.suppressed') THEN 'failed' ELSE status END,
    failure_code=CASE WHEN p_event_type='email.bounced' THEN 'hard_bounce' WHEN p_event_type='email.failed' THEN 'provider_failed' WHEN p_event_type='email.suppressed' THEN 'provider_suppressed' ELSE failure_code END,
    updated_at=now()
  WHERE provider_message_id=p_message_id;

  IF p_event_type IN ('email.bounced','email.complained','email.suppressed') THEN
    v_reason:=CASE WHEN p_event_type='email.complained' THEN 'complaint' ELSE 'hard_bounce' END;
    INSERT INTO public.marketing_suppressions(user_id,reason,source) VALUES(v_user,v_reason,'resend_webhook')
    ON CONFLICT(user_id) DO UPDATE SET reason=EXCLUDED.reason,source=EXCLUDED.source,created_at=now();
    UPDATE public.customer_marketing_preferences SET email_opt_in=false,withdrawn_at=now(),updated_at=now() WHERE user_id=v_user;
    UPDATE public.marketing_campaign_recipients SET status='suppressed',updated_at=now()
      WHERE user_id=v_user AND status IN ('pending','failed');
  END IF;
  RETURN true;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.record_marketing_email_event(TEXT,TEXT,TEXT,TIMESTAMPTZ) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.record_marketing_email_event(TEXT,TEXT,TEXT,TIMESTAMPTZ) TO service_role;

DO $$ BEGIN
  IF has_table_privilege('authenticated','public.marketing_email_events','SELECT') THEN
    RAISE EXCEPTION 'SECURITY_ASSERTION_FAILED: email delivery events exposed';
  END IF;
END $$;
