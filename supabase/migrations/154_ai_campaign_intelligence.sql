-- Privacy-bounded intelligence for AI-assisted lifecycle campaigns.
ALTER TABLE public.marketing_campaigns ADD COLUMN IF NOT EXISTS ai_request_id UUID;
CREATE UNIQUE INDEX IF NOT EXISTS idx_marketing_campaigns_ai_request
  ON public.marketing_campaigns(ai_request_id) WHERE ai_request_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.ai_campaign_intelligence_report(p_inactivity_days INT DEFAULT 30)
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,auth AS $$
WITH latest AS (
  SELECT DISTINCT ON (s.subject_id) s.*
  FROM public.onboarding_journey_state s
  WHERE s.subject_id IS NOT NULL
  ORDER BY s.subject_id,s.last_event_at DESC NULLS LAST
), classified AS (
  SELECT l.*,
    CASE
      WHEN l.account_created_at IS NOT NULL AND l.email_verified_at IS NULL AND l.account_created_at<now()-interval '1 hour' THEN 'registered_not_verified'
      WHEN l.email_verified_at IS NOT NULL AND l.kyc_completed_at IS NULL AND l.email_verified_at<now()-interval '24 hours' THEN 'verified_kyc_incomplete'
      WHEN l.kyc_completed_at IS NOT NULL AND l.first_funding_at IS NULL AND l.kyc_completed_at<now()-interval '72 hours' THEN 'kyc_completed_not_funded'
      WHEN l.first_funding_at IS NOT NULL AND l.first_purchase_at IS NULL AND l.first_funding_at<now()-interval '24 hours' THEN 'funded_not_purchased'
      WHEN l.last_event_at<now()-make_interval(days=>greatest(1,least(coalesce(p_inactivity_days,30),365))) THEN 'inactive'
    END segment,
    CASE
      WHEN l.account_created_at IS NOT NULL AND l.email_verified_at IS NULL THEN l.account_created_at
      WHEN l.email_verified_at IS NOT NULL AND l.kyc_completed_at IS NULL THEN l.email_verified_at
      WHEN l.kyc_completed_at IS NOT NULL AND l.first_funding_at IS NULL THEN l.kyc_completed_at
      WHEN l.first_funding_at IS NOT NULL AND l.first_purchase_at IS NULL THEN l.first_funding_at
      ELSE l.last_event_at
    END entered_at
  FROM latest l
), eligible AS (
  SELECT c.*,(au.email IS NOT NULL AND au.email_confirmed_at IS NOT NULL AND
    p.email_opt_in AND p.withdrawn_at IS NULL AND x.user_id IS NULL) consent_eligible
  FROM classified c
  LEFT JOIN auth.users au ON au.id=c.subject_id
  LEFT JOIN public.customer_marketing_preferences p ON p.user_id=c.subject_id
  LEFT JOIN public.marketing_suppressions x ON x.user_id=c.subject_id
  WHERE c.segment IS NOT NULL
), segments(segment) AS (VALUES
  ('registered_not_verified'::TEXT),('verified_kyc_incomplete'),('kyc_completed_not_funded'),
  ('funded_not_purchased'),('inactive')
), aggregate_rows AS (
  SELECT s.segment,count(e.subject_id) population,
    count(e.subject_id) FILTER(WHERE e.consent_eligible) consent_eligible,
    round((percentile_cont(.5) WITHIN GROUP(ORDER BY extract(epoch FROM now()-e.entered_at)/86400.0) FILTER(WHERE e.entered_at IS NOT NULL))::numeric,1) median_days,
    round((percentile_cont(.75) WITHIN GROUP(ORDER BY extract(epoch FROM now()-e.entered_at)/86400.0) FILTER(WHERE e.entered_at IS NOT NULL))::numeric,1) p75_days,
    round((max(extract(epoch FROM now()-e.entered_at)/86400.0) FILTER(WHERE e.entered_at IS NOT NULL))::numeric,1) longest_days,
    count(e.subject_id) FILTER(WHERE e.failure_count>0) affected_by_failures,
    coalesce(sum(e.failure_count),0) failure_attempts
  FROM segments s LEFT JOIN eligible e ON e.segment=s.segment GROUP BY s.segment
)
SELECT jsonb_build_object('generated_at',now(),'inactivity_days',greatest(1,least(coalesce(p_inactivity_days,30),365)),
  'segments',(SELECT jsonb_agg(jsonb_build_object(
    'segment',a.segment,'population',a.population,'consent_eligible',a.consent_eligible,
    'waiting_time',jsonb_build_object('median_days',a.median_days,'p75_days',a.p75_days,'longest_days',a.longest_days),
    'failures',jsonb_build_object('affected_customers',a.affected_by_failures,'attempts',a.failure_attempts,
      'top_codes',coalesce((SELECT jsonb_agg(jsonb_build_object('code',f.last_failure_code,'customers',f.customers) ORDER BY f.customers DESC)
        FROM (SELECT e.last_failure_code,count(*) customers FROM eligible e WHERE e.segment=a.segment AND e.last_failure_code IS NOT NULL GROUP BY e.last_failure_code ORDER BY count(*) DESC LIMIT 5) f),'[]'::jsonb)),
    'breakdowns',jsonb_build_object(
      'platform',coalesce((SELECT jsonb_agg(jsonb_build_object('value',b.value,'customers',b.customers) ORDER BY b.customers DESC) FROM (SELECT coalesce(e.platform,'unknown') value,count(*) customers FROM eligible e WHERE e.segment=a.segment GROUP BY 1 ORDER BY 2 DESC LIMIT 5)b),'[]'::jsonb),
      'country',coalesce((SELECT jsonb_agg(jsonb_build_object('value',b.value,'customers',b.customers) ORDER BY b.customers DESC) FROM (SELECT coalesce(e.country_code,'unknown') value,count(*) customers FROM eligible e WHERE e.segment=a.segment GROUP BY 1 ORDER BY 2 DESC LIMIT 5)b),'[]'::jsonb),
      'app_version',coalesce((SELECT jsonb_agg(jsonb_build_object('value',b.value,'customers',b.customers) ORDER BY b.customers DESC) FROM (SELECT coalesce(e.app_version,'unknown') value,count(*) customers FROM eligible e WHERE e.segment=a.segment GROUP BY 1 ORDER BY 2 DESC LIMIT 5)b),'[]'::jsonb)
    )) ORDER BY array_position(ARRAY['registered_not_verified','verified_kyc_incomplete','kyc_completed_not_funded','funded_not_purchased','inactive'],a.segment)) FROM aggregate_rows a)
);
$$;
REVOKE EXECUTE ON FUNCTION public.ai_campaign_intelligence_report(INT) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.ai_campaign_intelligence_report(INT) TO service_role;

DO $$ BEGIN
  IF has_table_privilege('authenticated','public.onboarding_journey_state','SELECT') THEN
    RAISE EXCEPTION 'SECURITY_ASSERTION_FAILED: journey details exposed';
  END IF;
END $$;
