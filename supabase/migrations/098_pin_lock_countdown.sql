-- Read-only status for the signed-in user's transaction-PIN lockout.
-- The server remains authoritative; the client uses retry_after_seconds only
-- to render a helpful countdown and never to authorize a transaction.
CREATE OR REPLACE FUNCTION public.get_user_pin_lock_status()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_attempts INTEGER;
  v_locked_until TIMESTAMPTZ;
  v_retry_after INTEGER := 0;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED';
  END IF;

  SELECT attempts, locked_until
    INTO v_attempts, v_locked_until
    FROM public.user_pins
   WHERE user_id = v_uid;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'has_pin', false,
      'locked', false,
      'retry_after_seconds', 0,
      'attempts_remaining', 0
    );
  END IF;

  IF v_locked_until IS NOT NULL AND v_locked_until > clock_timestamp() THEN
    v_retry_after := GREATEST(
      CEIL(EXTRACT(EPOCH FROM (v_locked_until - clock_timestamp())))::INTEGER,
      1
    );
  END IF;

  RETURN jsonb_build_object(
    'has_pin', true,
    'locked', v_retry_after > 0,
    'locked_until', v_locked_until,
    'retry_after_seconds', v_retry_after,
    'attempts_remaining', CASE
      WHEN v_retry_after > 0 THEN 0
      ELSE GREATEST(5 - COALESCE(v_attempts, 0), 0)
    END
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_user_pin_lock_status() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_user_pin_lock_status() TO authenticated, service_role;

