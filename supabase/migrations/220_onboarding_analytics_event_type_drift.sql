-- Fix schema/code drift on onboarding_analytics_events: the event_type and
-- outcome CHECK constraints were never updated as analytics-ingest/index.ts
-- grew its allowed EVENTS/OUTCOMES sets past migration 148's original list.
-- Confirmed by grepping every migration for the newer event type strings
-- (crypto_buy_started, esim_started, foreign_number_started, kyc_viewed,
-- pin_setup_failed, email_verification_deferred, etc.) -- zero matches
-- anywhere. Every one of those event types has been silently rejected by
-- Postgres with a CHECK violation (surfaced to the client as an HTTP 400 on
-- the upsert) since the day each was added to the edge function, meaning
-- crypto buy, foreign number, NIN services, eSIM, and airtime/data/
-- electricity/TV funnel analytics have never actually been recorded.
--
-- Purely additive: every value currently allowed stays allowed, this only
-- widens both constraints to match what analytics-ingest/index.ts has
-- already been sending. No existing row, index, or code path is touched.

-- Drop by actual name rather than a guessed one, in case naming ever
-- drifted from Postgres's default {table}_{column}_check convention (used
-- consistently elsewhere in this codebase, e.g. transactions_type_check
-- across migrations 004/013/015/018/026/033/082/117/128 -- but verified
-- here rather than assumed, since a silently-surviving stricter constraint
-- under a different name would defeat this whole migration).
DO $$
DECLARE v_name TEXT;
BEGIN
  FOR v_name IN
    SELECT c.conname FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
    WHERE c.conrelid = 'public.onboarding_analytics_events'::regclass
      AND c.contype = 'c' AND a.attname = 'event_type'
  LOOP
    EXECUTE format('ALTER TABLE public.onboarding_analytics_events DROP CONSTRAINT %I', v_name);
  END LOOP;
END $$;

ALTER TABLE public.onboarding_analytics_events
  ADD CONSTRAINT onboarding_analytics_events_event_type_check CHECK (event_type IN (
    'app_opened','onboarding_started','onboarding_slide_viewed','onboarding_skipped',
    'registration_started','registration_validation_failed','registration_submitted',
    'account_created','email_verification_started','email_verification_failed','email_verified',
    'email_verification_deferred',
    'pin_setup_completed','pin_setup_failed','biometric_offer_completed','home_viewed',
    'kyc_viewed','kyc_started','kyc_failed','kyc_completed',
    'funding_viewed','funding_started','funding_failed',
    'first_funding_completed','first_purchase_completed',
    'crypto_buy_started','crypto_buy_failed',
    'foreign_number_started','foreign_number_failed','foreign_number_completed',
    'nin_services_started','nin_services_failed','nin_services_completed',
    'esim_started','esim_failed','esim_completed',
    'data_started','data_failed',
    'airtime_started','airtime_failed',
    'electricity_started','electricity_failed',
    'tv_started','tv_failed'
  ));

DO $$
DECLARE v_name TEXT;
BEGIN
  FOR v_name IN
    SELECT c.conname FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
    WHERE c.conrelid = 'public.onboarding_analytics_events'::regclass
      AND c.contype = 'c' AND a.attname = 'outcome'
  LOOP
    EXECUTE format('ALTER TABLE public.onboarding_analytics_events DROP CONSTRAINT %I', v_name);
  END LOOP;
END $$;

ALTER TABLE public.onboarding_analytics_events
  ADD CONSTRAINT onboarding_analytics_events_outcome_check
  CHECK (outcome IS NULL OR outcome IN ('view','started','completed','failed','skipped','deferred'));

-- Deployment-time assertion: confirm both constraints now accept a
-- representative previously-rejected value, without actually inserting a
-- fake row (would need a real installation_id to satisfy the FK).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.onboarding_analytics_events'::regclass
      AND conname = 'onboarding_analytics_events_event_type_check'
      AND pg_get_constraintdef(oid) LIKE '%crypto_buy_started%'
  ) THEN
    RAISE EXCEPTION 'MIGRATION_ASSERTION_FAILED: event_type check does not include crypto_buy_started';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.onboarding_analytics_events'::regclass
      AND conname = 'onboarding_analytics_events_outcome_check'
      AND pg_get_constraintdef(oid) LIKE '%deferred%'
  ) THEN
    RAISE EXCEPTION 'MIGRATION_ASSERTION_FAILED: outcome check does not include deferred';
  END IF;
END $$;
