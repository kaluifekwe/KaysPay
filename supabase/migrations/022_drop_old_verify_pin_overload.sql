-- Kay's Pay: drop the stale single-arg verify_user_pin overload
-- =====================================================================
-- Migration 021 added verify_user_pin(p_pin, p_max_uses) to mint a step-up
-- token on success. Postgres treats an added trailing parameter as a NEW
-- overload rather than a replacement, so the original 006 signature
-- verify_user_pin(p_pin) was left behind — still callable, still correctly
-- checking the PIN + lockout, but never mints a token. Not a security hole
-- on its own (nothing trusts it to authorize money movement), just dead
-- code that could confuse future callers into using the wrong signature.
-- =====================================================================

DROP FUNCTION IF EXISTS public.verify_user_pin(TEXT);
