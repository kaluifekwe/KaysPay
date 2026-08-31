-- A campaign must never transition to approved when its current, consent-eligible audience is empty.
CREATE OR REPLACE FUNCTION public.approve_marketing_campaign(p_campaign_id UUID,p_admin_id UUID) RETURNS INT
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
  IF v_count<1 THEN RAISE EXCEPTION 'NO_ELIGIBLE_RECIPIENTS'; END IF;
  UPDATE public.marketing_campaigns SET status='approved',approved_by=p_admin_id,approved_at=now(),updated_at=now() WHERE id=p_campaign_id;
  RETURN v_count;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.approve_marketing_campaign(UUID,UUID) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.approve_marketing_campaign(UUID,UUID) TO service_role;
