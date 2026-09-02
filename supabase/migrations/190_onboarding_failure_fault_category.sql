-- Tags every known onboarding failure_code with who's actually responsible
-- for it, so the admin dashboard (and the AI assistant, which reads this
-- same RPC's output verbatim) can distinguish "our app broke" from "the
-- provider rejected/was unavailable" from "the customer mistyped something",
-- instead of just a raw code string. Deliberately a fixed CASE over KNOWN
-- codes (see analytics.service.ts's AnalyticsEventType comments for where
-- each one is fired) rather than a guess -- an unrecognized code (a future
-- failure type nobody's categorized yet) falls into 'unclassified' rather
-- than being silently mis-labeled.
--
-- Everything else in this function is byte-identical to migration 181 --
-- only the `failures` CTE gained the fault_category column.
CREATE OR REPLACE FUNCTION public.admin_onboarding_funnel_report(
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
    SELECT e.event_type,e.failure_code,
      count(DISTINCT e.installation_id) affected_installations,count(*) attempts,
      CASE e.failure_code
        -- Customer typed/entered something the app rejected before ever
        -- reaching a provider -- not a bug, not a provider problem.
        WHEN 'personal_details_invalid' THEN 'customer_input'
        WHEN 'identity_length_invalid' THEN 'customer_input'
        WHEN 'code_rejected' THEN 'customer_input'
        WHEN 'pin_mismatch' THEN 'customer_input'
        -- A provider (Supabase Auth, VTUnaija/Quidax's KYC lookup, Resend)
        -- actively responded with a decline -- their call, not ours.
        WHEN 'signup_rejected' THEN 'provider_rejected'
        WHEN 'identity_rejected' THEN 'provider_rejected'
        WHEN 'code_send_failed' THEN 'provider_rejected'
        -- A provider couldn't be reached at all, or didn't confirm in time.
        WHEN 'signup_unavailable' THEN 'provider_unavailable'
        WHEN 'code_send_unavailable' THEN 'provider_unavailable'
        WHEN 'virtual_account_unavailable' THEN 'provider_unavailable'
        WHEN 'transfer_not_confirmed' THEN 'provider_unavailable'
        -- Our own save/write failed on our side, retries exhausted.
        WHEN 'pin_save_failed' THEN 'app_error'
        -- A caught exception with no more specific cause known -- genuinely
        -- ambiguous (could be either side), not worth guessing further.
        WHEN 'verification_unavailable' THEN 'unknown'
        ELSE 'unclassified'
      END AS fault_category
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
    jsonb_build_object('key','app_opened','count',t.activated),
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
