-- Phase 6C: maker-checker control for emergency restriction overrides.
-- A normal release after verified-email PIN reset still needs one super admin.
-- An override without reverification needs two different active super admins.

CREATE TABLE public.security_override_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restriction_id UUID NOT NULL REFERENCES public.financial_restrictions(id),
  case_id UUID NOT NULL REFERENCES public.security_cases(id),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  request_reason TEXT NOT NULL CHECK (length(request_reason) BETWEEN 10 AND 500),
  requested_by UUID NOT NULL REFERENCES auth.users(id),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_by UUID REFERENCES auth.users(id),
  decided_at TIMESTAMPTZ,
  decision_notes TEXT CHECK (decision_notes IS NULL OR length(decision_notes)<=500),
  CHECK (decided_by IS NULL OR decided_by<>requested_by)
);
CREATE UNIQUE INDEX idx_one_pending_security_override
  ON public.security_override_approvals(restriction_id) WHERE status='pending';
CREATE INDEX idx_security_override_pending
  ON public.security_override_approvals(requested_at DESC) WHERE status='pending';

ALTER TABLE public.security_override_approvals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.security_override_approvals FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.security_override_approvals TO service_role;

CREATE OR REPLACE FUNCTION public.admin_request_restriction_override(
  p_admin_user_id UUID,p_restriction_id UUID,p_reason TEXT
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_row public.financial_restrictions%ROWTYPE; v_approval_id UUID;
BEGIN
  IF p_admin_user_id IS NULL OR p_restriction_id IS NULL OR length(trim(p_reason)) NOT BETWEEN 10 AND 500 THEN
    RAISE EXCEPTION 'INVALID_OVERRIDE_REQUEST';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.admin_users WHERE user_id=p_admin_user_id AND role='super_admin' AND disabled_at IS NULL) THEN
    RAISE EXCEPTION 'SUPER_ADMIN_REQUIRED';
  END IF;
  IF (SELECT count(*) FROM public.admin_users WHERE role='super_admin' AND disabled_at IS NULL)<2 THEN
    RAISE EXCEPTION 'SECOND_SUPER_ADMIN_REQUIRED';
  END IF;
  SELECT * INTO v_row FROM public.financial_restrictions WHERE id=p_restriction_id AND status='active' FOR UPDATE;
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'ACTIVE_RESTRICTION_NOT_FOUND'; END IF;
  IF EXISTS(
    SELECT 1 FROM public.security_events
    WHERE user_id=v_row.user_id AND event_type='transaction_pin_reset' AND created_at>=v_row.imposed_at
  ) THEN RAISE EXCEPTION 'OVERRIDE_NOT_REQUIRED'; END IF;

  INSERT INTO public.security_override_approvals(restriction_id,case_id,user_id,request_reason,requested_by)
  VALUES(v_row.id,v_row.case_id,v_row.user_id,trim(p_reason),p_admin_user_id)
  RETURNING id INTO v_approval_id;
  INSERT INTO public.admin_actions(admin_user_id,action_type,target_type,target_id,reason,metadata)
  VALUES(p_admin_user_id,'restriction_override_requested','financial_restrictions',v_row.id::TEXT,trim(p_reason),jsonb_build_object('approval_id',v_approval_id,'case_id',v_row.case_id));
  INSERT INTO public.security_events(user_id,event_type,severity,source,metadata)
  VALUES(v_row.user_id,'restriction_override_requested','warning','security-response',jsonb_build_object('approval_id',v_approval_id,'case_id',v_row.case_id));
  RETURN jsonb_build_object('success',true,'approval_id',v_approval_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_decide_restriction_override(
  p_admin_user_id UUID,p_approval_id UUID,p_approve BOOLEAN,p_notes TEXT
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_approval public.security_override_approvals%ROWTYPE; v_restriction public.financial_restrictions%ROWTYPE;
BEGIN
  IF p_admin_user_id IS NULL OR p_approval_id IS NULL OR length(trim(p_notes)) NOT BETWEEN 5 AND 500 THEN
    RAISE EXCEPTION 'INVALID_OVERRIDE_DECISION';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.admin_users WHERE user_id=p_admin_user_id AND role='super_admin' AND disabled_at IS NULL) THEN
    RAISE EXCEPTION 'SUPER_ADMIN_REQUIRED';
  END IF;
  SELECT * INTO v_approval FROM public.security_override_approvals WHERE id=p_approval_id AND status='pending' FOR UPDATE;
  IF v_approval.id IS NULL THEN RAISE EXCEPTION 'PENDING_APPROVAL_NOT_FOUND'; END IF;
  IF v_approval.requested_by=p_admin_user_id THEN RAISE EXCEPTION 'SELF_APPROVAL_FORBIDDEN'; END IF;

  IF NOT p_approve THEN
    UPDATE public.security_override_approvals SET status='rejected',decided_by=p_admin_user_id,decided_at=now(),decision_notes=trim(p_notes)
    WHERE id=v_approval.id;
    INSERT INTO public.admin_actions(admin_user_id,action_type,target_type,target_id,reason,metadata)
    VALUES(p_admin_user_id,'restriction_override_rejected','financial_restrictions',v_approval.restriction_id::TEXT,trim(p_notes),jsonb_build_object('approval_id',v_approval.id,'requested_by',v_approval.requested_by));
    INSERT INTO public.security_events(user_id,event_type,severity,source,metadata)
    VALUES(v_approval.user_id,'restriction_override_rejected','info','security-response',jsonb_build_object('approval_id',v_approval.id));
    RETURN jsonb_build_object('success',true,'status','rejected');
  END IF;

  SELECT * INTO v_restriction FROM public.financial_restrictions
  WHERE id=v_approval.restriction_id AND status='active' FOR UPDATE;
  IF v_restriction.id IS NULL THEN RAISE EXCEPTION 'ACTIVE_RESTRICTION_NOT_FOUND'; END IF;

  UPDATE public.financial_restrictions SET
    status='lifted',lifted_by=p_admin_user_id,lifted_at=now(),
    lift_reason=trim(v_approval.request_reason)||' | Checker: '||trim(p_notes),
    reverification_method='super_admin_override'
  WHERE id=v_restriction.id;
  UPDATE public.security_cases SET status='resolved',resolved_at=now(),resolved_by=p_admin_user_id,
    resolution_notes='Emergency override approved by a second super admin: '||trim(p_notes)
  WHERE id=v_restriction.case_id;
  UPDATE public.security_override_approvals SET status='approved',decided_by=p_admin_user_id,decided_at=now(),decision_notes=trim(p_notes)
  WHERE id=v_approval.id;
  INSERT INTO public.notifications(user_id,title,body,type,data) VALUES(
    v_restriction.user_id,'Security restriction removed',
    'A security review has been completed and financial transactions are available again.',
    'system',jsonb_build_object('event','financial_restriction_lifted')
  );
  INSERT INTO public.security_events(user_id,event_type,severity,source,metadata)
  VALUES(v_restriction.user_id,'restriction_override_approved','warning','security-response',
    jsonb_build_object('approval_id',v_approval.id,'case_id',v_restriction.case_id,'maker',v_approval.requested_by,'checker',p_admin_user_id));
  INSERT INTO public.admin_actions(admin_user_id,action_type,target_type,target_id,reason,metadata)
  VALUES(p_admin_user_id,'restriction_override_approved','financial_restrictions',v_restriction.id::TEXT,trim(p_notes),
    jsonb_build_object('approval_id',v_approval.id,'requested_by',v_approval.requested_by,'case_id',v_restriction.case_id));
  RETURN jsonb_build_object('success',true,'status','approved');
END;
$$;

-- Direct override is disabled. This function now handles only the ordinary
-- verified-email PIN-reset release path.
CREATE OR REPLACE FUNCTION public.admin_lift_financial_restriction(
  p_admin_user_id UUID,p_restriction_id UUID,p_reason TEXT,p_override BOOLEAN DEFAULT FALSE
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_row public.financial_restrictions%ROWTYPE; v_reverified BOOLEAN;
BEGIN
  IF p_admin_user_id IS NULL OR p_restriction_id IS NULL OR length(trim(p_reason)) NOT BETWEEN 5 AND 500 THEN
    RAISE EXCEPTION 'INVALID_RESTRICTION_RELEASE';
  END IF;
  IF p_override THEN RETURN jsonb_build_object('success',false,'error','DUAL_APPROVAL_REQUIRED'); END IF;
  IF NOT EXISTS(SELECT 1 FROM public.admin_users WHERE user_id=p_admin_user_id AND role='super_admin' AND disabled_at IS NULL) THEN
    RAISE EXCEPTION 'SUPER_ADMIN_REQUIRED';
  END IF;
  SELECT * INTO v_row FROM public.financial_restrictions WHERE id=p_restriction_id AND status='active' FOR UPDATE;
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'ACTIVE_RESTRICTION_NOT_FOUND'; END IF;
  SELECT EXISTS(SELECT 1 FROM public.security_events WHERE user_id=v_row.user_id AND event_type='transaction_pin_reset' AND created_at>=v_row.imposed_at) INTO v_reverified;
  IF NOT v_reverified THEN RETURN jsonb_build_object('success',false,'error','REVERIFICATION_REQUIRED'); END IF;

  UPDATE public.financial_restrictions SET status='lifted',lifted_by=p_admin_user_id,lifted_at=now(),lift_reason=trim(p_reason),reverification_method='verified_email_pin_reset' WHERE id=v_row.id;
  UPDATE public.security_cases SET status='resolved',resolved_at=now(),resolved_by=p_admin_user_id,resolution_notes=trim(p_reason) WHERE id=v_row.case_id;
  UPDATE public.security_override_approvals SET status='cancelled',decided_at=now(),decision_notes='Customer completed verified-email PIN reset' WHERE restriction_id=v_row.id AND status='pending';
  INSERT INTO public.notifications(user_id,title,body,type,data) VALUES(v_row.user_id,'Security restriction removed','Your verification is complete and financial transactions are available again.','system',jsonb_build_object('event','financial_restriction_lifted'));
  INSERT INTO public.security_events(user_id,event_type,severity,source,metadata) VALUES(v_row.user_id,'financial_restriction_lifted','info','security-response',jsonb_build_object('case_id',v_row.case_id,'restriction_id',v_row.id,'override',false));
  INSERT INTO public.admin_actions(admin_user_id,action_type,target_type,target_id,reason,metadata) VALUES(p_admin_user_id,'lift_restriction','users',v_row.user_id::TEXT,trim(p_reason),jsonb_build_object('case_id',v_row.case_id,'restriction_id',v_row.id,'override',false));
  RETURN jsonb_build_object('success',true,'reverification_method','verified_email_pin_reset');
END;
$$;

REVOKE EXECUTE ON FUNCTION public.admin_request_restriction_override(UUID,UUID,TEXT) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.admin_decide_restriction_override(UUID,UUID,BOOLEAN,TEXT) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.admin_request_restriction_override(UUID,UUID,TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_decide_restriction_override(UUID,UUID,BOOLEAN,TEXT) TO service_role;
