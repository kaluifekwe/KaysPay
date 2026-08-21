-- Remove the set_user_pin NULL-token compatibility fallback (2026-08-21).
-- =====================================================================
-- Migration 057 added set_user_pin(p_pin, p_auth_token) with a shim: when
-- p_auth_token came through NULL, it silently looked up the caller's newest
-- unexpired, unconsumed step-up token and used that instead. That existed
-- only to keep the then-installed production client working, since it
-- verified the old PIN but did not yet forward the returned token.
--
-- That client is gone. src/services/auth.service.ts now always passes
-- p_auth_token explicitly, and every user is on the 1.0.1 runtime, so the
-- fallback is dead code that only weakens the guarantee: it let ANY live
-- token satisfy the PIN change — including one minted seconds earlier to
-- authorize an unrelated action, such as an airtime purchase. Dropping it
-- re-binds "change my PIN" to a step-up performed for that change.
--
-- Behaviour after this migration:
--   * First-time PIN creation (no existing PIN)  -> unchanged, no token needed.
--   * Changing an existing PIN without a token   -> raises STEP_UP_REQUIRED.
--   * Changing an existing PIN with a valid token-> unchanged, works as today.
-- The signature, grants, and PIN hashing are all deliberately identical to
-- 057 so nothing else about the function's contract shifts.

CREATE OR REPLACE FUNCTION public.set_user_pin(p_pin TEXT, p_auth_token TEXT DEFAULT NULL)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_has_pin BOOLEAN;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED';
  END IF;
  IF p_pin !~ '^\d{4}$' THEN
    RAISE EXCEPTION 'INVALID_PIN';
  END IF;

  SELECT EXISTS (SELECT 1 FROM public.user_pins WHERE user_id = v_uid)
    INTO v_has_pin;

  IF v_has_pin THEN
    -- No NULL fallback: the caller must present the token minted by
    -- verify_user_pin for THIS change. consume_transaction_auth_token
    -- returns false for a NULL, expired, unknown, or already-used token.
    IF NOT public.consume_transaction_auth_token(v_uid, p_auth_token) THEN
      RAISE EXCEPTION 'STEP_UP_REQUIRED';
    END IF;
  END IF;

  INSERT INTO public.user_pins (user_id, pin_hash, attempts, locked_until, updated_at)
  VALUES (v_uid, crypt(p_pin, gen_salt('bf', 10)), 0, NULL, now())
  ON CONFLICT (user_id) DO UPDATE
    SET pin_hash = EXCLUDED.pin_hash,
        attempts = 0,
        locked_until = NULL,
        updated_at = now();
END;
$$;

-- CREATE OR REPLACE resets ownership-independent grants on some PG versions;
-- re-assert the exact allowlist 057 established so the client keeps working
-- and anon stays locked out.
REVOKE EXECUTE ON FUNCTION public.set_user_pin(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_user_pin(TEXT, TEXT) TO authenticated, service_role;

-- Deployment-time assertions, matching the pattern 057 introduced: fail the
-- migration loudly rather than silently shipping a broken boundary.
DO $$
BEGIN
  IF has_function_privilege('anon', 'public.set_user_pin(text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'SECURITY_ASSERTION_FAILED: anon can set PIN';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.set_user_pin(text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'SECURITY_ASSERTION_FAILED: client cannot set PIN';
  END IF;
END $$;
