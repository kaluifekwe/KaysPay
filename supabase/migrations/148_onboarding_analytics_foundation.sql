-- Phase 1: privacy-bounded onboarding analytics foundation.
-- Raw journey events are deliberately separate from financial/audit records:
-- they have shorter retention, a small fixed vocabulary, and contain no
-- free-form customer text or sensitive financial/identity fields.

CREATE TABLE public.analytics_installations (
  installation_id UUID PRIMARY KEY,
  subject_id UUID REFERENCES public.customer_subjects(subject_id),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  linked_at TIMESTAMPTZ,
  CHECK ((subject_id IS NULL AND linked_at IS NULL) OR (subject_id IS NOT NULL AND linked_at IS NOT NULL))
);
CREATE INDEX idx_analytics_installations_subject ON public.analytics_installations(subject_id) WHERE subject_id IS NOT NULL;

CREATE TABLE public.onboarding_analytics_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id UUID NOT NULL UNIQUE,
  installation_id UUID NOT NULL REFERENCES public.analytics_installations(installation_id),
  subject_id UUID REFERENCES public.customer_subjects(subject_id),
  session_id UUID NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'app_opened','onboarding_started','onboarding_slide_viewed','onboarding_skipped',
    'registration_started','registration_validation_failed','registration_submitted',
    'account_created','email_verification_started','email_verification_failed','email_verified',
    'pin_setup_completed','biometric_offer_completed','home_viewed','kyc_started','kyc_failed',
    'kyc_completed','funding_viewed','funding_started','funding_failed',
    'first_funding_completed','first_purchase_completed'
  )),
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('view','started','completed','failed','skipped')),
  occurred_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  app_version TEXT CHECK (app_version IS NULL OR app_version ~ '^[0-9A-Za-z._+-]{1,32}$'),
  build_number TEXT CHECK (build_number IS NULL OR build_number ~ '^[0-9A-Za-z._+-]{1,32}$'),
  platform TEXT CHECK (platform IS NULL OR platform IN ('android','ios','web','unknown')),
  os_major SMALLINT CHECK (os_major IS NULL OR os_major BETWEEN 7 AND 100),
  network_type TEXT CHECK (network_type IS NULL OR network_type IN ('wifi','cellular','offline','unknown')),
  locale TEXT CHECK (locale IS NULL OR locale ~ '^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})?$'),
  country_code TEXT CHECK (country_code IS NULL OR country_code ~ '^[A-Z]{2}$'),
  region_code TEXT CHECK (region_code IS NULL OR region_code ~ '^[A-Za-z0-9_-]{1,16}$'),
  acquisition_source TEXT CHECK (acquisition_source IS NULL OR acquisition_source ~ '^[A-Za-z0-9._-]{1,64}$'),
  failure_code TEXT CHECK (failure_code IS NULL OR failure_code ~ '^[a-z0-9_]{2,64}$'),
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (length(metadata::TEXT) <= 512),
  CHECK (occurred_at >= received_at - INTERVAL '7 days' AND occurred_at <= received_at + INTERVAL '5 minutes')
);
CREATE INDEX idx_onboarding_events_time ON public.onboarding_analytics_events(occurred_at DESC, id DESC);
CREATE INDEX idx_onboarding_events_funnel ON public.onboarding_analytics_events(event_type, occurred_at DESC);
CREATE INDEX idx_onboarding_events_subject ON public.onboarding_analytics_events(subject_id, occurred_at DESC) WHERE subject_id IS NOT NULL;
CREATE INDEX idx_onboarding_events_installation ON public.onboarding_analytics_events(installation_id, occurred_at DESC);

ALTER TABLE public.analytics_installations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.onboarding_analytics_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.analytics_installations, public.onboarding_analytics_events FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.analytics_installations TO service_role;
GRANT SELECT, INSERT, DELETE ON public.onboarding_analytics_events TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.onboarding_analytics_events_id_seq TO service_role;

-- Atomic installation ownership/linking. Once linked, an installation can
-- never be reassigned to a different customer.
CREATE FUNCTION public.register_analytics_installation(p_installation_id UUID, p_subject_id UUID DEFAULT NULL)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_existing_subject UUID;
BEGIN
  SELECT subject_id INTO v_existing_subject
  FROM public.analytics_installations
  WHERE installation_id=p_installation_id
  FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public.analytics_installations(installation_id,subject_id,linked_at)
    VALUES(p_installation_id,p_subject_id,CASE WHEN p_subject_id IS NULL THEN NULL ELSE now() END);
  ELSE
    IF v_existing_subject IS NOT NULL AND (p_subject_id IS NULL OR v_existing_subject<>p_subject_id) THEN
      RAISE EXCEPTION 'ANALYTICS_INSTALLATION_OWNERSHIP_MISMATCH';
    END IF;
    UPDATE public.analytics_installations
    SET subject_id=COALESCE(subject_id,p_subject_id),
        linked_at=CASE WHEN subject_id IS NULL AND p_subject_id IS NOT NULL THEN now() ELSE linked_at END,
        last_seen_at=now()
    WHERE installation_id=p_installation_id;

    IF p_subject_id IS NOT NULL THEN
      UPDATE public.onboarding_analytics_events
      SET subject_id=p_subject_id
      WHERE installation_id=p_installation_id AND subject_id IS NULL;
    END IF;
  END IF;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.register_analytics_installation(UUID,UUID) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.register_analytics_installation(UUID,UUID) TO service_role;

-- Raw-event retention: 90 days for journeys that never became an account,
-- 400 days for linked journeys. Durable reports must use aggregate tables,
-- not retain identifiable clickstream indefinitely.
CREATE FUNCTION public.cleanup_onboarding_analytics() RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_anonymous INT; v_linked INT; v_installations INT;
BEGIN
  WITH deleted AS (
    DELETE FROM public.onboarding_analytics_events
    WHERE subject_id IS NULL AND received_at < now() - INTERVAL '90 days'
    RETURNING 1
  ) SELECT count(*) INTO v_anonymous FROM deleted;

  WITH deleted AS (
    DELETE FROM public.onboarding_analytics_events
    WHERE subject_id IS NOT NULL AND received_at < now() - INTERVAL '400 days'
    RETURNING 1
  ) SELECT count(*) INTO v_linked FROM deleted;

  WITH deleted AS (
    DELETE FROM public.analytics_installations i
    WHERE i.subject_id IS NULL AND i.last_seen_at < now() - INTERVAL '90 days'
      AND NOT EXISTS (SELECT 1 FROM public.onboarding_analytics_events e WHERE e.installation_id=i.installation_id)
    RETURNING 1
  ) SELECT count(*) INTO v_installations FROM deleted;

  RETURN jsonb_build_object('anonymous_events',v_anonymous,'linked_events',v_linked,'installations',v_installations);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.cleanup_onboarding_analytics() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_onboarding_analytics() TO service_role;

SELECT cron.schedule('onboarding-analytics-retention','17 3 * * *',
  $$SELECT public.cleanup_onboarding_analytics()$$);

DO $$
BEGIN
  IF has_table_privilege('authenticated','public.onboarding_analytics_events','SELECT')
     OR has_table_privilege('authenticated','public.onboarding_analytics_events','INSERT') THEN
    RAISE EXCEPTION 'SECURITY_ASSERTION_FAILED: client can access onboarding analytics directly';
  END IF;
END $$;
