-- Phase 3: one-row-per-installation funnel state and bounded admin report.
-- This prevents dashboard requests from repeatedly scanning the raw event
-- stream and keeps financial completion milestones server-authoritative.

CREATE TABLE public.onboarding_journey_state (
  installation_id UUID PRIMARY KEY REFERENCES public.analytics_installations(installation_id) ON DELETE CASCADE,
  subject_id UUID REFERENCES public.customer_subjects(subject_id),
  first_app_opened_at TIMESTAMPTZ,
  onboarding_started_at TIMESTAMPTZ,
  registration_started_at TIMESTAMPTZ,
  account_created_at TIMESTAMPTZ,
  email_verified_at TIMESTAMPTZ,
  pin_setup_at TIMESTAMPTZ,
  home_viewed_at TIMESTAMPTZ,
  kyc_started_at TIMESTAMPTZ,
  kyc_completed_at TIMESTAMPTZ,
  funding_viewed_at TIMESTAMPTZ,
  funding_started_at TIMESTAMPTZ,
  first_funding_at TIMESTAMPTZ,
  first_purchase_at TIMESTAMPTZ,
  last_event_type TEXT,
  last_event_at TIMESTAMPTZ,
  last_failure_type TEXT,
  last_failure_code TEXT,
  last_failure_at TIMESTAMPTZ,
  failure_count INT NOT NULL DEFAULT 0 CHECK(failure_count>=0),
  app_version TEXT,
  build_number TEXT,
  platform TEXT,
  os_major SMALLINT,
  network_type TEXT,
  locale TEXT,
  country_code TEXT,
  region_code TEXT,
  acquisition_source TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_onboarding_journey_cohort ON public.onboarding_journey_state(first_app_opened_at DESC);
CREATE INDEX idx_onboarding_journey_subject ON public.onboarding_journey_state(subject_id) WHERE subject_id IS NOT NULL;
CREATE INDEX idx_onboarding_journey_dimensions ON public.onboarding_journey_state(platform,app_version,country_code,first_app_opened_at DESC);

ALTER TABLE public.onboarding_journey_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.onboarding_journey_state FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.onboarding_journey_state TO service_role;

CREATE FUNCTION public.update_onboarding_journey_state() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  INSERT INTO public.onboarding_journey_state(
    installation_id,subject_id,first_app_opened_at,onboarding_started_at,
    registration_started_at,account_created_at,email_verified_at,pin_setup_at,
    home_viewed_at,kyc_started_at,kyc_completed_at,funding_viewed_at,
    funding_started_at,first_funding_at,first_purchase_at,last_event_type,last_event_at,
    last_failure_type,last_failure_code,last_failure_at,failure_count,
    app_version,build_number,platform,os_major,network_type,locale,country_code,
    region_code,acquisition_source
  ) VALUES (
    NEW.installation_id,NEW.subject_id,
    CASE WHEN NEW.event_type='app_opened' THEN NEW.occurred_at END,
    CASE WHEN NEW.event_type='onboarding_started' THEN NEW.occurred_at END,
    CASE WHEN NEW.event_type='registration_started' THEN NEW.occurred_at END,
    CASE WHEN NEW.event_type='account_created' THEN NEW.occurred_at END,
    CASE WHEN NEW.event_type='email_verified' THEN NEW.occurred_at END,
    CASE WHEN NEW.event_type='pin_setup_completed' THEN NEW.occurred_at END,
    CASE WHEN NEW.event_type='home_viewed' THEN NEW.occurred_at END,
    CASE WHEN NEW.event_type='kyc_started' THEN NEW.occurred_at END,
    CASE WHEN NEW.event_type='kyc_completed' THEN NEW.occurred_at END,
    CASE WHEN NEW.event_type='funding_viewed' THEN NEW.occurred_at END,
    CASE WHEN NEW.event_type='funding_started' THEN NEW.occurred_at END,
    NULL,NULL,
    NEW.event_type,NEW.occurred_at,
    CASE WHEN NEW.outcome='failed' THEN NEW.event_type END,
    CASE WHEN NEW.outcome='failed' THEN NEW.failure_code END,
    CASE WHEN NEW.outcome='failed' THEN NEW.occurred_at END,
    CASE WHEN NEW.outcome='failed' THEN 1 ELSE 0 END,
    NEW.app_version,NEW.build_number,NEW.platform,NEW.os_major,NEW.network_type,
    NEW.locale,NEW.country_code,NEW.region_code,NEW.acquisition_source
  )
  ON CONFLICT(installation_id) DO UPDATE SET
    subject_id=COALESCE(onboarding_journey_state.subject_id,EXCLUDED.subject_id),
    first_app_opened_at=LEAST(onboarding_journey_state.first_app_opened_at,EXCLUDED.first_app_opened_at),
    onboarding_started_at=LEAST(onboarding_journey_state.onboarding_started_at,EXCLUDED.onboarding_started_at),
    registration_started_at=LEAST(onboarding_journey_state.registration_started_at,EXCLUDED.registration_started_at),
    account_created_at=LEAST(onboarding_journey_state.account_created_at,EXCLUDED.account_created_at),
    email_verified_at=LEAST(onboarding_journey_state.email_verified_at,EXCLUDED.email_verified_at),
    pin_setup_at=LEAST(onboarding_journey_state.pin_setup_at,EXCLUDED.pin_setup_at),
    home_viewed_at=LEAST(onboarding_journey_state.home_viewed_at,EXCLUDED.home_viewed_at),
    kyc_started_at=LEAST(onboarding_journey_state.kyc_started_at,EXCLUDED.kyc_started_at),
    kyc_completed_at=LEAST(onboarding_journey_state.kyc_completed_at,EXCLUDED.kyc_completed_at),
    funding_viewed_at=LEAST(onboarding_journey_state.funding_viewed_at,EXCLUDED.funding_viewed_at),
    funding_started_at=LEAST(onboarding_journey_state.funding_started_at,EXCLUDED.funding_started_at),
    first_funding_at=LEAST(onboarding_journey_state.first_funding_at,EXCLUDED.first_funding_at),
    first_purchase_at=LEAST(onboarding_journey_state.first_purchase_at,EXCLUDED.first_purchase_at),
    last_event_type=CASE WHEN EXCLUDED.last_event_at>=onboarding_journey_state.last_event_at THEN EXCLUDED.last_event_type ELSE onboarding_journey_state.last_event_type END,
    last_event_at=GREATEST(onboarding_journey_state.last_event_at,EXCLUDED.last_event_at),
    last_failure_type=CASE WHEN EXCLUDED.last_failure_at>=onboarding_journey_state.last_failure_at THEN EXCLUDED.last_failure_type ELSE onboarding_journey_state.last_failure_type END,
    last_failure_code=CASE WHEN EXCLUDED.last_failure_at>=onboarding_journey_state.last_failure_at THEN EXCLUDED.last_failure_code ELSE onboarding_journey_state.last_failure_code END,
    last_failure_at=GREATEST(onboarding_journey_state.last_failure_at,EXCLUDED.last_failure_at),
    failure_count=onboarding_journey_state.failure_count+EXCLUDED.failure_count,
    app_version=COALESCE(onboarding_journey_state.app_version,EXCLUDED.app_version),
    build_number=COALESCE(onboarding_journey_state.build_number,EXCLUDED.build_number),
    platform=COALESCE(onboarding_journey_state.platform,EXCLUDED.platform),
    os_major=COALESCE(onboarding_journey_state.os_major,EXCLUDED.os_major),
    network_type=COALESCE(onboarding_journey_state.network_type,EXCLUDED.network_type),
    locale=COALESCE(onboarding_journey_state.locale,EXCLUDED.locale),
    country_code=COALESCE(onboarding_journey_state.country_code,EXCLUDED.country_code),
    region_code=COALESCE(onboarding_journey_state.region_code,EXCLUDED.region_code),
    acquisition_source=COALESCE(onboarding_journey_state.acquisition_source,EXCLUDED.acquisition_source),
    updated_at=now();
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.update_onboarding_journey_state() FROM PUBLIC,anon,authenticated;

CREATE TRIGGER trg_update_onboarding_journey_state
AFTER INSERT ON public.onboarding_analytics_events
FOR EACH ROW EXECUTE FUNCTION public.update_onboarding_journey_state();

-- Build state for any events received between Phase 1 deployment and this migration.
INSERT INTO public.onboarding_journey_state(
  installation_id,subject_id,first_app_opened_at,onboarding_started_at,registration_started_at,
  account_created_at,email_verified_at,pin_setup_at,home_viewed_at,kyc_started_at,
  kyc_completed_at,funding_viewed_at,funding_started_at,first_funding_at,first_purchase_at,
  last_event_type,last_event_at,last_failure_type,last_failure_code,last_failure_at,failure_count,
  app_version,build_number,platform,os_major,network_type,locale,country_code,region_code,acquisition_source
)
SELECT installation_id,(array_agg(subject_id) FILTER(WHERE subject_id IS NOT NULL))[1],
  min(occurred_at) FILTER(WHERE event_type='app_opened'),
  min(occurred_at) FILTER(WHERE event_type='onboarding_started'),
  min(occurred_at) FILTER(WHERE event_type='registration_started'),
  min(occurred_at) FILTER(WHERE event_type='account_created'),
  min(occurred_at) FILTER(WHERE event_type='email_verified'),
  min(occurred_at) FILTER(WHERE event_type='pin_setup_completed'),
  min(occurred_at) FILTER(WHERE event_type='home_viewed'),
  min(occurred_at) FILTER(WHERE event_type='kyc_started'),
  min(occurred_at) FILTER(WHERE event_type='kyc_completed'),
  min(occurred_at) FILTER(WHERE event_type='funding_viewed'),
  min(occurred_at) FILTER(WHERE event_type='funding_started'),
  NULL,NULL,
  (array_agg(event_type ORDER BY occurred_at DESC,id DESC))[1],max(occurred_at),
  (array_agg(event_type ORDER BY occurred_at DESC,id DESC) FILTER(WHERE outcome='failed'))[1],
  (array_agg(failure_code ORDER BY occurred_at DESC,id DESC) FILTER(WHERE outcome='failed'))[1],
  max(occurred_at) FILTER(WHERE outcome='failed'),count(*) FILTER(WHERE outcome='failed'),
  (array_agg(app_version ORDER BY occurred_at,id) FILTER(WHERE app_version IS NOT NULL))[1],
  (array_agg(build_number ORDER BY occurred_at,id) FILTER(WHERE build_number IS NOT NULL))[1],
  (array_agg(platform ORDER BY occurred_at,id) FILTER(WHERE platform IS NOT NULL))[1],
  (array_agg(os_major ORDER BY occurred_at,id) FILTER(WHERE os_major IS NOT NULL))[1],
  (array_agg(network_type ORDER BY occurred_at,id) FILTER(WHERE network_type IS NOT NULL))[1],
  (array_agg(locale ORDER BY occurred_at,id) FILTER(WHERE locale IS NOT NULL))[1],
  (array_agg(country_code ORDER BY occurred_at,id) FILTER(WHERE country_code IS NOT NULL))[1],
  (array_agg(region_code ORDER BY occurred_at,id) FILTER(WHERE region_code IS NOT NULL))[1],
  (array_agg(acquisition_source ORDER BY occurred_at,id) FILTER(WHERE acquisition_source IS NOT NULL))[1]
FROM public.onboarding_analytics_events GROUP BY installation_id
ON CONFLICT(installation_id) DO NOTHING;

-- Propagate the authenticated subject onto the already-created anonymous state.
CREATE FUNCTION public.link_onboarding_journey_subject() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF NEW.subject_id IS NOT NULL AND OLD.subject_id IS NULL THEN
    UPDATE public.onboarding_journey_state SET subject_id=NEW.subject_id,updated_at=now()
    WHERE installation_id=NEW.installation_id AND subject_id IS NULL;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.link_onboarding_journey_subject() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER trg_link_onboarding_journey_subject
AFTER UPDATE OF subject_id ON public.analytics_installations
FOR EACH ROW EXECUTE FUNCTION public.link_onboarding_journey_subject();

-- Funding and first purchase are derived from the authoritative transaction
-- row, never from a claim made by the mobile client.
CREATE FUNCTION public.update_onboarding_financial_milestone() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF NEW.status<>'completed' THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND OLD.status='completed' THEN RETURN NEW; END IF;

  IF NEW.type='wallet_fund' THEN
    UPDATE public.onboarding_journey_state
    SET first_funding_at=LEAST(first_funding_at,NEW.created_at),updated_at=now()
    WHERE subject_id=NEW.user_id AND first_app_opened_at<=NEW.created_at;
  ELSIF NEW.type NOT IN ('refund','withdrawal','wallet_fund','card_fund','transfer','crypto_sell') THEN
    UPDATE public.onboarding_journey_state
    SET first_purchase_at=LEAST(first_purchase_at,NEW.created_at),updated_at=now()
    WHERE subject_id=NEW.user_id AND first_app_opened_at<=NEW.created_at;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.update_onboarding_financial_milestone() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER trg_update_onboarding_financial_milestone
AFTER INSERT OR UPDATE OF status ON public.transactions
FOR EACH ROW EXECUTE FUNCTION public.update_onboarding_financial_milestone();

CREATE OR REPLACE FUNCTION public.cleanup_onboarding_analytics() RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_anonymous INT; v_linked INT; v_installations INT; v_states INT;
BEGIN
  WITH deleted AS (
    DELETE FROM public.onboarding_analytics_events
    WHERE subject_id IS NULL AND received_at<now()-INTERVAL '90 days' RETURNING 1
  ) SELECT count(*) INTO v_anonymous FROM deleted;
  WITH deleted AS (
    DELETE FROM public.onboarding_analytics_events
    WHERE subject_id IS NOT NULL AND received_at<now()-INTERVAL '400 days' RETURNING 1
  ) SELECT count(*) INTO v_linked FROM deleted;
  WITH deleted AS (
    DELETE FROM public.onboarding_journey_state
    WHERE (subject_id IS NULL AND updated_at<now()-INTERVAL '90 days')
       OR (subject_id IS NOT NULL AND updated_at<now()-INTERVAL '400 days') RETURNING 1
  ) SELECT count(*) INTO v_states FROM deleted;
  WITH deleted AS (
    DELETE FROM public.analytics_installations i
    WHERE i.subject_id IS NULL AND i.last_seen_at<now()-INTERVAL '90 days'
      AND NOT EXISTS(SELECT 1 FROM public.onboarding_analytics_events e WHERE e.installation_id=i.installation_id)
    RETURNING 1
  ) SELECT count(*) INTO v_installations FROM deleted;
  RETURN jsonb_build_object('anonymous_events',v_anonymous,'linked_events',v_linked,'journey_states',v_states,'installations',v_installations);
END;
$$;

CREATE FUNCTION public.admin_onboarding_funnel_report(
  p_start TIMESTAMPTZ,p_end TIMESTAMPTZ,p_platform TEXT DEFAULT NULL,
  p_app_version TEXT DEFAULT NULL,p_country_code TEXT DEFAULT NULL,
  p_network_type TEXT DEFAULT NULL,p_acquisition_source TEXT DEFAULT NULL
) RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
WITH cohort AS (
  SELECT * FROM public.onboarding_journey_state s
  WHERE s.first_app_opened_at>=p_start AND s.first_app_opened_at<p_end
    AND (p_platform IS NULL OR s.platform=p_platform)
    AND (p_app_version IS NULL OR s.app_version=p_app_version)
    AND (p_country_code IS NULL OR s.country_code=p_country_code)
    AND (p_network_type IS NULL OR s.network_type=p_network_type)
    AND (p_acquisition_source IS NULL OR s.acquisition_source=p_acquisition_source)
), totals AS (
  SELECT count(*) activated,
    count(*) FILTER(WHERE onboarding_started_at IS NOT NULL) onboarding,
    count(*) FILTER(WHERE registration_started_at IS NOT NULL) registration_started,
    count(*) FILTER(WHERE account_created_at IS NOT NULL) accounts,
    count(*) FILTER(WHERE email_verified_at IS NOT NULL) verified,
    count(*) FILTER(WHERE pin_setup_at IS NOT NULL) pin_setup,
    count(*) FILTER(WHERE home_viewed_at IS NOT NULL) home,
    count(*) FILTER(WHERE kyc_started_at IS NOT NULL) kyc_started,
    count(*) FILTER(WHERE kyc_completed_at IS NOT NULL) kyc_completed,
    count(*) FILTER(WHERE funding_started_at IS NOT NULL) funding_started,
    count(*) FILTER(WHERE first_funding_at IS NOT NULL) funded,
    count(*) FILTER(WHERE first_purchase_at IS NOT NULL) purchased
  FROM cohort
), failures AS (
  SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.affected_installations DESC,x.attempts DESC),'[]'::jsonb) value
  FROM (
    SELECT e.event_type,e.failure_code,count(DISTINCT e.installation_id) affected_installations,count(*) attempts
    FROM public.onboarding_analytics_events e JOIN cohort c USING(installation_id)
    WHERE e.outcome='failed' AND e.occurred_at<p_end
    GROUP BY e.event_type,e.failure_code ORDER BY count(DISTINCT e.installation_id) DESC LIMIT 20
  ) x
), breakdowns AS (
  SELECT jsonb_build_object(
    'platform',COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.installations DESC) FROM (SELECT COALESCE(platform,'unknown') value,count(*) installations FROM cohort GROUP BY 1) x),'[]'::jsonb),
    'app_version',COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.installations DESC) FROM (SELECT COALESCE(app_version,'unknown') value,count(*) installations FROM cohort GROUP BY 1) x),'[]'::jsonb),
    'country',COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.installations DESC) FROM (SELECT COALESCE(country_code,'unknown') value,count(*) installations FROM cohort GROUP BY 1) x),'[]'::jsonb),
    'network',COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.installations DESC) FROM (SELECT COALESCE(network_type,'unknown') value,count(*) installations FROM cohort GROUP BY 1) x),'[]'::jsonb)
  ) value
), timing AS (
  SELECT jsonb_build_object(
    'activation_to_account_median_seconds',percentile_cont(0.5) WITHIN GROUP(ORDER BY extract(epoch FROM account_created_at-first_app_opened_at)) FILTER(WHERE account_created_at>=first_app_opened_at),
    'activation_to_account_p75_seconds',percentile_cont(0.75) WITHIN GROUP(ORDER BY extract(epoch FROM account_created_at-first_app_opened_at)) FILTER(WHERE account_created_at>=first_app_opened_at),
    'account_to_verification_median_seconds',percentile_cont(0.5) WITHIN GROUP(ORDER BY extract(epoch FROM email_verified_at-account_created_at)) FILTER(WHERE email_verified_at>=account_created_at),
    'account_to_verification_p75_seconds',percentile_cont(0.75) WITHIN GROUP(ORDER BY extract(epoch FROM email_verified_at-account_created_at)) FILTER(WHERE email_verified_at>=account_created_at),
    'verification_to_home_median_seconds',percentile_cont(0.5) WITHIN GROUP(ORDER BY extract(epoch FROM home_viewed_at-email_verified_at)) FILTER(WHERE home_viewed_at>=email_verified_at),
    'verification_to_home_p75_seconds',percentile_cont(0.75) WITHIN GROUP(ORDER BY extract(epoch FROM home_viewed_at-email_verified_at)) FILTER(WHERE home_viewed_at>=email_verified_at),
    'kyc_to_funding_median_seconds',percentile_cont(0.5) WITHIN GROUP(ORDER BY extract(epoch FROM first_funding_at-kyc_completed_at)) FILTER(WHERE first_funding_at>=kyc_completed_at),
    'kyc_to_funding_p75_seconds',percentile_cont(0.75) WITHIN GROUP(ORDER BY extract(epoch FROM first_funding_at-kyc_completed_at)) FILTER(WHERE first_funding_at>=kyc_completed_at),
    'funding_to_purchase_median_seconds',percentile_cont(0.5) WITHIN GROUP(ORDER BY extract(epoch FROM first_purchase_at-first_funding_at)) FILTER(WHERE first_purchase_at>=first_funding_at),
    'funding_to_purchase_p75_seconds',percentile_cont(0.75) WITHIN GROUP(ORDER BY extract(epoch FROM first_purchase_at-first_funding_at)) FILTER(WHERE first_purchase_at>=first_funding_at)
  ) value FROM cohort
), stuck AS (
  SELECT jsonb_build_object(
    'registered_not_verified',count(*) FILTER(WHERE account_created_at IS NOT NULL AND email_verified_at IS NULL AND account_created_at<now()-INTERVAL '1 hour'),
    'verified_pin_incomplete',count(*) FILTER(WHERE email_verified_at IS NOT NULL AND pin_setup_at IS NULL AND email_verified_at<now()-INTERVAL '1 hour'),
    'home_kyc_not_started',count(*) FILTER(WHERE home_viewed_at IS NOT NULL AND kyc_started_at IS NULL AND home_viewed_at<now()-INTERVAL '24 hours'),
    'kyc_not_completed',count(*) FILTER(WHERE kyc_started_at IS NOT NULL AND kyc_completed_at IS NULL AND kyc_started_at<now()-INTERVAL '24 hours'),
    'kyc_completed_not_funded',count(*) FILTER(WHERE kyc_completed_at IS NOT NULL AND first_funding_at IS NULL AND kyc_completed_at<now()-INTERVAL '72 hours'),
    'funding_started_not_completed',count(*) FILTER(WHERE funding_started_at IS NOT NULL AND first_funding_at IS NULL AND funding_started_at<now()-INTERVAL '1 hour'),
    'funded_not_purchased',count(*) FILTER(WHERE first_funding_at IS NOT NULL AND first_purchase_at IS NULL AND first_funding_at<now()-INTERVAL '24 hours')
  ) value FROM cohort
)
SELECT jsonb_build_object(
  'cohort',jsonb_build_object('start',p_start,'end',p_end,'installations',t.activated),
  'conversion',jsonb_build_object(
    'activation_to_account_percent',round(100.0*t.accounts/nullif(t.activated,0),2),
    'account_to_verification_percent',round(100.0*t.verified/nullif(t.accounts,0),2),
    'verification_to_home_percent',round(100.0*t.home/nullif(t.verified,0),2),
    'home_to_kyc_percent',round(100.0*t.kyc_completed/nullif(t.home,0),2),
    'kyc_to_funding_percent',round(100.0*t.funded/nullif(t.kyc_completed,0),2),
    'funding_to_purchase_percent',round(100.0*t.purchased/nullif(t.funded,0),2),
    'overall_activation_percent',round(100.0*t.purchased/nullif(t.activated,0),2)
  ),
  'stages',jsonb_build_array(
    jsonb_build_object('key','app_opened','count',t.activated),jsonb_build_object('key','onboarding_started','count',t.onboarding),
    jsonb_build_object('key','registration_started','count',t.registration_started),jsonb_build_object('key','account_created','count',t.accounts),
    jsonb_build_object('key','email_verified','count',t.verified),jsonb_build_object('key','pin_setup','count',t.pin_setup),
    jsonb_build_object('key','home_viewed','count',t.home),jsonb_build_object('key','kyc_started','count',t.kyc_started),
    jsonb_build_object('key','kyc_completed','count',t.kyc_completed),jsonb_build_object('key','funding_started','count',t.funding_started),
    jsonb_build_object('key','first_funding','count',t.funded),jsonb_build_object('key','first_purchase','count',t.purchased)
  ),'timing',timing.value,'stuck',stuck.value,'failures',failures.value,'breakdowns',breakdowns.value
) FROM totals t CROSS JOIN timing CROSS JOIN stuck CROSS JOIN failures CROSS JOIN breakdowns;
$$;
REVOKE EXECUTE ON FUNCTION public.admin_onboarding_funnel_report(TIMESTAMPTZ,TIMESTAMPTZ,TEXT,TEXT,TEXT,TEXT,TEXT) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.admin_onboarding_funnel_report(TIMESTAMPTZ,TIMESTAMPTZ,TEXT,TEXT,TEXT,TEXT,TEXT) TO service_role;

DO $$ BEGIN
  IF has_table_privilege('authenticated','public.onboarding_journey_state','SELECT') THEN
    RAISE EXCEPTION 'SECURITY_ASSERTION_FAILED: client can read journey state';
  END IF;
END $$;
