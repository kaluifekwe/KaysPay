-- Owner approved 2026-09-03: nudge the ~16 real installations still on the
-- old v20-ota runtime (hardcoded to report build 21 client-side, since
-- expo-application isn't compiled into that build) toward updating, now
-- that real evidence (the Onboarding page's App Version breakdown) showed
-- a meaningful chunk of the active base is still there. Starts in
-- "Recommended" (dismissible) mode, not "Required" -- a hard block on 16
-- real, currently-active/transacting users without warning first is too
-- disruptive; escalate to Required later only if the nudge is ignored.
-- 25 is the real current latest finished Android build (confirmed via
-- `eas build:list`, built 2026-08-31) -- also correctly catches anyone
-- still on build 24, not just the older v20-ota population.
UPDATE public.app_version_gate
SET min_build_number = 25, required = false, updated_at = now()
WHERE platform = 'android';
