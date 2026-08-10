-- Phase 6B: manual, reversible security-response controls.
-- Restrictions affect outgoing financial authorization only. They never
-- debit, credit, lock, or otherwise mutate a wallet balance.

CREATE TABLE public.security_cases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  severity TEXT NOT NULL CHECK (severity IN ('warning','critical')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  summary TEXT NOT NULL CHECK (length(summary) BETWEEN 5 AND 200),
  created_by UUID NOT NULL REFERENCES auth.users(id),
  assigned_to UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  resolved_by UUID REFERENCES auth.users(id),
  resolution_notes TEXT CHECK (resolution_notes IS NULL OR length(resolution_notes)<=500)
);
CREATE INDEX idx_security_cases_user_created ON public.security_cases(user_id,created_at DESC);
CREATE INDEX idx_security_cases_open ON public.security_cases(created_at DESC) WHERE status='open';

CREATE TABLE public.financial_restrictions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id UUID NOT NULL REFERENCES public.security_cases(id),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','lifted')),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 10 AND 500),
  imposed_by UUID NOT NULL REFERENCES auth.users(id),
  imposed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lifted_by UUID REFERENCES auth.users(id),
  lifted_at TIMESTAMPTZ,
  lift_reason TEXT CHECK (lift_reason IS NULL OR length(lift_reason)<=500),
  reverification_method TEXT CHECK (reverification_method IS NULL OR reverification_method IN ('verified_email_pin_reset','super_admin_override'))
);
CREATE UNIQUE INDEX idx_one_active_financial_restriction
  ON public.financial_restrictions(user_id) WHERE status='active';
CREATE INDEX idx_financial_restrictions_case ON public.financial_restrictions(case_id);

ALTER TABLE public.security_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.financial_restrictions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.security_cases,public.financial_restrictions FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.security_cases,public.financial_restrictions TO service_role;

CREATE OR REPLACE FUNCTION public.is_financial_action_allowed(p_user_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT p_user_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM public.financial_restrictions
    WHERE user_id=p_user_id AND status='active'
  )
$$;
REVOKE EXECUTE ON FUNCTION public.is_financial_action_allowed(UUID) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.is_financial_action_allowed(UUID) TO service_role;

-- The authenticated customer may read only their current restriction state.
-- The reason and internal case notes remain admin-only.
CREATE OR REPLACE FUNCTION public.get_my_financial_restriction_status()
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT CASE WHEN auth.uid() IS NULL THEN jsonb_build_object('restricted',false)
    ELSE COALESCE((
      SELECT jsonb_build_object(
        'restricted',true,
        'imposed_at',imposed_at,
        'message','Financial transactions are temporarily restricted. Reset your transaction PIN using your verified email or contact support.'
      ) FROM public.financial_restrictions
      WHERE user_id=auth.uid() AND status='active' LIMIT 1
    ),jsonb_build_object('restricted',false)) END
$$;
REVOKE EXECUTE ON FUNCTION public.get_my_financial_restriction_status() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_my_financial_restriction_status() TO authenticated,service_role;

-- Refuse to mint a new step-up token while restricted, and return an
-- explicit machine-readable reason so the app can explain what happened.
CREATE OR REPLACE FUNCTION public.verify_user_pin(p_pin TEXT,p_max_uses INT DEFAULT 1)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,extensions AS $$
DECLARE
  v_uid UUID:=auth.uid(); v_row user_pins%ROWTYPE; v_max INT:=5; v_lock_mins INT:=15;
  v_token TEXT; v_ttl_secs INT; v_expires_at TIMESTAMPTZ; v_unlocked_after_lockout BOOLEAN:=FALSE;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;
  IF NOT public.is_financial_action_allowed(v_uid) THEN
    RETURN jsonb_build_object('valid',false,'locked',false,'restricted',true,'error','FINANCIAL_ACTIONS_RESTRICTED');
  END IF;
  SELECT * INTO v_row FROM user_pins WHERE user_id=v_uid FOR UPDATE;
  IF v_row.user_id IS NULL THEN RETURN jsonb_build_object('valid',false,'locked',false,'error','NO_PIN_SET'); END IF;
  IF v_row.locked_until IS NOT NULL AND v_row.locked_until>now() THEN
    RETURN jsonb_build_object('valid',false,'locked',true,'locked_until',v_row.locked_until,'attempts_remaining',0);
  END IF;
  v_unlocked_after_lockout:=v_row.locked_until IS NOT NULL;
  IF v_row.pin_hash=crypt(p_pin,v_row.pin_hash) THEN
    UPDATE user_pins SET attempts=0,locked_until=NULL,updated_at=now() WHERE user_id=v_uid;
    IF v_unlocked_after_lockout THEN
      INSERT INTO public.security_events(user_id,event_type,severity,source,metadata)
      VALUES(v_uid,'transaction_pin_unlock_after_lockout','info','transaction-pin','{}');
    END IF;
    DELETE FROM transaction_auth_tokens WHERE user_id=v_uid AND expires_at<now();
    v_token:=encode(gen_random_bytes(32),'hex');
    v_ttl_secs:=180+(GREATEST(COALESCE(p_max_uses,1),1)-1)*3;
    v_expires_at:=now()+make_interval(secs=>v_ttl_secs);
    INSERT INTO transaction_auth_tokens(token,user_id,max_uses,expires_at)
    VALUES(v_token,v_uid,GREATEST(COALESCE(p_max_uses,1),1),v_expires_at);
    RETURN jsonb_build_object('valid',true,'locked',false,'token',v_token,'expires_at',v_expires_at);
  END IF;
  IF v_row.attempts+1>=v_max THEN
    UPDATE user_pins SET attempts=0,locked_until=now()+make_interval(mins=>v_lock_mins),updated_at=now() WHERE user_id=v_uid;
    INSERT INTO public.security_events(user_id,event_type,severity,source,metadata)
    VALUES(v_uid,'transaction_pin_lockout','warning','transaction-pin',jsonb_build_object('max_attempts',v_max,'lock_minutes',v_lock_mins));
    RETURN jsonb_build_object('valid',false,'locked',true,'locked_until',now()+make_interval(mins=>v_lock_mins),'attempts_remaining',0);
  END IF;
  UPDATE user_pins SET attempts=v_row.attempts+1,updated_at=now() WHERE user_id=v_uid;
  INSERT INTO public.security_events(user_id,event_type,severity,source,metadata)
  VALUES(v_uid,'transaction_pin_failed','warning','transaction-pin',jsonb_build_object('attempts_remaining',v_max-(v_row.attempts+1)));
  RETURN jsonb_build_object('valid',false,'locked',false,'attempts_remaining',v_max-(v_row.attempts+1));
END;
$$;
REVOKE EXECUTE ON FUNCTION public.verify_user_pin(TEXT,INT) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.verify_user_pin(TEXT,INT) TO authenticated,service_role;

-- Defence in depth: even an already-issued step-up token cannot be consumed
-- after a restriction is imposed.
CREATE OR REPLACE FUNCTION public.consume_transaction_auth_token(p_user_id UUID,p_token TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_claimed BOOLEAN:=FALSE;
BEGIN
  IF p_token IS NULL OR p_token='' OR NOT public.is_financial_action_allowed(p_user_id) THEN
    RETURN FALSE;
  END IF;
  UPDATE transaction_auth_tokens SET uses_count=uses_count+1
  WHERE token=p_token AND user_id=p_user_id AND expires_at>now() AND uses_count<max_uses;
  GET DIAGNOSTICS v_claimed=ROW_COUNT;
  RETURN v_claimed;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.consume_transaction_auth_token(UUID,TEXT) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.consume_transaction_auth_token(UUID,TEXT) TO service_role;

CREATE OR REPLACE FUNCTION public.admin_apply_financial_restriction(
  p_admin_user_id UUID,p_user_id UUID,p_summary TEXT,p_reason TEXT,p_severity TEXT DEFAULT 'critical'
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_case_id UUID; v_restriction_id UUID; v_sessions INT;
BEGIN
  IF p_admin_user_id IS NULL OR p_user_id IS NULL
     OR length(trim(p_summary)) NOT BETWEEN 5 AND 200
     OR length(trim(p_reason)) NOT BETWEEN 10 AND 500
     OR p_severity NOT IN ('warning','critical') THEN
    RAISE EXCEPTION 'INVALID_SECURITY_RESTRICTION';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.admin_users WHERE user_id=p_admin_user_id AND role='super_admin' AND disabled_at IS NULL) THEN
    RAISE EXCEPTION 'SUPER_ADMIN_REQUIRED';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM auth.users WHERE id=p_user_id) THEN RAISE EXCEPTION 'USER_NOT_FOUND'; END IF;
  IF EXISTS(SELECT 1 FROM public.financial_restrictions WHERE user_id=p_user_id AND status='active') THEN
    RAISE EXCEPTION 'ACCOUNT_ALREADY_RESTRICTED';
  END IF;

  INSERT INTO public.security_cases(user_id,severity,summary,created_by,assigned_to)
  VALUES(p_user_id,p_severity,trim(p_summary),p_admin_user_id,p_admin_user_id) RETURNING id INTO v_case_id;
  INSERT INTO public.financial_restrictions(case_id,user_id,reason,imposed_by)
  VALUES(v_case_id,p_user_id,trim(p_reason),p_admin_user_id) RETURNING id INTO v_restriction_id;

  UPDATE public.device_sessions SET revoked_at=now() WHERE user_id=p_user_id AND revoked_at IS NULL;
  GET DIAGNOSTICS v_sessions=ROW_COUNT;
  DELETE FROM public.transaction_auth_tokens WHERE user_id=p_user_id;

  INSERT INTO public.notifications(user_id,title,body,type,data) VALUES(
    p_user_id,'Security protection applied',
    'Financial transactions are temporarily restricted for your protection. Sign in again and reset your transaction PIN using your verified email, or contact support.',
    'system',jsonb_build_object('event','financial_restriction_applied')
  );
  INSERT INTO public.security_events(user_id,event_type,severity,source,metadata) VALUES(
    p_user_id,'financial_restriction_applied','critical','security-response',
    jsonb_build_object('case_id',v_case_id,'restriction_id',v_restriction_id,'sessions_revoked',v_sessions)
  );
  INSERT INTO public.admin_actions(admin_user_id,action_type,target_type,target_id,reason,metadata)
  VALUES(p_admin_user_id,'restrict_financial','users',p_user_id::TEXT,trim(p_reason),jsonb_build_object('case_id',v_case_id,'restriction_id',v_restriction_id));
  RETURN jsonb_build_object('success',true,'case_id',v_case_id,'restriction_id',v_restriction_id,'sessions_revoked',v_sessions);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_lift_financial_restriction(
  p_admin_user_id UUID,p_restriction_id UUID,p_reason TEXT,p_override BOOLEAN DEFAULT FALSE
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_row public.financial_restrictions%ROWTYPE; v_reverified BOOLEAN;
BEGIN
  IF p_admin_user_id IS NULL OR p_restriction_id IS NULL OR length(trim(p_reason)) NOT BETWEEN 5 AND 500 THEN
    RAISE EXCEPTION 'INVALID_RESTRICTION_RELEASE';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.admin_users WHERE user_id=p_admin_user_id AND role='super_admin' AND disabled_at IS NULL) THEN
    RAISE EXCEPTION 'SUPER_ADMIN_REQUIRED';
  END IF;
  SELECT * INTO v_row FROM public.financial_restrictions WHERE id=p_restriction_id AND status='active' FOR UPDATE;
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'ACTIVE_RESTRICTION_NOT_FOUND'; END IF;
  SELECT EXISTS(
    SELECT 1 FROM public.security_events
    WHERE user_id=v_row.user_id AND event_type='transaction_pin_reset' AND created_at>=v_row.imposed_at
  ) INTO v_reverified;
  IF NOT v_reverified AND NOT p_override THEN
    RETURN jsonb_build_object('success',false,'error','REVERIFICATION_REQUIRED');
  END IF;

  UPDATE public.financial_restrictions SET
    status='lifted',lifted_by=p_admin_user_id,lifted_at=now(),lift_reason=trim(p_reason),
    reverification_method=CASE WHEN v_reverified THEN 'verified_email_pin_reset' ELSE 'super_admin_override' END
  WHERE id=v_row.id;
  UPDATE public.security_cases SET
    status='resolved',resolved_at=now(),resolved_by=p_admin_user_id,resolution_notes=trim(p_reason)
  WHERE id=v_row.case_id;
  INSERT INTO public.notifications(user_id,title,body,type,data) VALUES(
    v_row.user_id,'Security restriction removed',
    'Your verification is complete and financial transactions are available again.',
    'system',jsonb_build_object('event','financial_restriction_lifted')
  );
  INSERT INTO public.security_events(user_id,event_type,severity,source,metadata) VALUES(
    v_row.user_id,'financial_restriction_lifted','info','security-response',
    jsonb_build_object('case_id',v_row.case_id,'restriction_id',v_row.id,'override',NOT v_reverified)
  );
  INSERT INTO public.admin_actions(admin_user_id,action_type,target_type,target_id,reason,metadata)
  VALUES(p_admin_user_id,'lift_restriction','users',v_row.user_id::TEXT,trim(p_reason),jsonb_build_object('case_id',v_row.case_id,'restriction_id',v_row.id,'override',NOT v_reverified));
  RETURN jsonb_build_object('success',true,'reverification_method',CASE WHEN v_reverified THEN 'verified_email_pin_reset' ELSE 'super_admin_override' END);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_revoke_user_sessions(
  p_admin_user_id UUID,p_user_id UUID,p_summary TEXT,p_reason TEXT
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_case_id UUID; v_sessions INT;
BEGIN
  IF p_admin_user_id IS NULL OR p_user_id IS NULL
     OR length(trim(p_summary)) NOT BETWEEN 5 AND 200
     OR length(trim(p_reason)) NOT BETWEEN 5 AND 500 THEN RAISE EXCEPTION 'INVALID_SESSION_RESPONSE'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.admin_users WHERE user_id=p_admin_user_id AND role='super_admin' AND disabled_at IS NULL) THEN
    RAISE EXCEPTION 'SUPER_ADMIN_REQUIRED';
  END IF;
  INSERT INTO public.security_cases(user_id,severity,status,summary,created_by,assigned_to,resolved_at,resolved_by,resolution_notes)
  VALUES(p_user_id,'warning','resolved',trim(p_summary),p_admin_user_id,p_admin_user_id,now(),p_admin_user_id,trim(p_reason))
  RETURNING id INTO v_case_id;
  UPDATE public.device_sessions SET revoked_at=now() WHERE user_id=p_user_id AND revoked_at IS NULL;
  GET DIAGNOSTICS v_sessions=ROW_COUNT;
  DELETE FROM public.transaction_auth_tokens WHERE user_id=p_user_id;
  INSERT INTO public.notifications(user_id,title,body,type,data) VALUES(
    p_user_id,'Sessions signed out for security',
    'Your active sessions were signed out for security. Please sign in again. If you did not request help, contact support.',
    'system',jsonb_build_object('event','admin_sessions_revoked')
  );
  INSERT INTO public.security_events(user_id,event_type,severity,source,metadata) VALUES(
    p_user_id,'admin_sessions_revoked','warning','security-response',
    jsonb_build_object('case_id',v_case_id,'sessions_revoked',v_sessions)
  );
  INSERT INTO public.admin_actions(admin_user_id,action_type,target_type,target_id,reason,metadata)
  VALUES(p_admin_user_id,'revoke_sessions','users',p_user_id::TEXT,trim(p_reason),jsonb_build_object('case_id',v_case_id,'sessions_revoked',v_sessions));
  RETURN jsonb_build_object('success',true,'case_id',v_case_id,'sessions_revoked',v_sessions);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.admin_apply_financial_restriction(UUID,UUID,TEXT,TEXT,TEXT) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.admin_lift_financial_restriction(UUID,UUID,TEXT,BOOLEAN) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.admin_revoke_user_sessions(UUID,UUID,TEXT,TEXT) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.admin_apply_financial_restriction(UUID,UUID,TEXT,TEXT,TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_lift_financial_restriction(UUID,UUID,TEXT,BOOLEAN) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_revoke_user_sessions(UUID,UUID,TEXT,TEXT) TO service_role;
