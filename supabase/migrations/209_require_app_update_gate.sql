-- Owner approved 2026-09-04: escalate the app update gate from
-- "Recommended" (dismissible, migration 206) to "Required" (hard block).
-- The dismissible nudge ran for about a day; a live check of active
-- installations in the last 7 days still showed 14 of 52 (27%) on the old
-- v20-ota runtime plus 3 more on build 24, not build 25 -- a dismissible
-- nudge alone wasn't going to collapse that population, and every OTA
-- publish this session has had to go to both runtimes to reach everyone.
-- min_build_number stays 25 (the real current latest Android build,
-- confirmed via `eas build:list`, 2026-08-31).
UPDATE public.app_version_gate
SET required = true, updated_at = now()
WHERE platform = 'android';
