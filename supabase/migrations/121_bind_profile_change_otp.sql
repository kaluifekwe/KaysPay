-- Bind every profile-change OTP to one exact pending destination.
-- Creation, verification, and consumption are atomic so a valid code can
-- never authorize a value written by a different request.

ALTER TABLE public.pending_profile_changes
  ADD COLUMN IF NOT EXISTS verification_code_id UUID
  REFERENCES public.email_verification_codes(id) ON DELETE CASCADE;

-- Existing pending rows predate destination binding and cannot be trusted.
DELETE FROM public.pending_profile_changes;

ALTER TABLE public.pending_profile_changes
  ALTER COLUMN verification_code_id SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_profile_changes_verification_code
  ON public.pending_profile_changes (verification_code_id);

CREATE OR REPLACE FUNCTION public.create_profile_change_verification(
  p_user_id UUID,
  p_field TEXT,
  p_new_value TEXT,
  p_purpose TEXT,
  p_code TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_last_created TIMESTAMPTZ;
  v_recent_count INT;
  v_code_id UUID;
BEGIN
  IF p_field IS NULL OR p_purpose IS NULL OR p_new_value IS NULL OR p_code IS NULL
     OR (p_field = 'email' AND p_purpose <> 'change_email')
     OR (p_field = 'phone' AND p_purpose <> 'change_phone')
     OR p_field NOT IN ('email', 'phone') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_REQUEST');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':' || p_purpose, 0));

  SELECT created_at INTO v_last_created
    FROM public.email_verification_codes
   WHERE user_id = p_user_id AND purpose = p_purpose
   ORDER BY created_at DESC
   LIMIT 1;

  IF v_last_created IS NOT NULL AND v_last_created > now() - INTERVAL '60 seconds' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'RATE_LIMITED');
  END IF;

  SELECT count(*) INTO v_recent_count
    FROM public.email_verification_codes
   WHERE user_id = p_user_id AND purpose = p_purpose
     AND created_at > now() - INTERVAL '24 hours';

  IF v_recent_count >= 10 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'DAILY_LIMIT_REACHED');
  END IF;

  INSERT INTO public.email_verification_codes (user_id, purpose, target, code_hash, expires_at)
  VALUES (p_user_id, p_purpose, p_new_value, crypt(p_code, gen_salt('bf', 10)), now() + INTERVAL '10 minutes')
  RETURNING id INTO v_code_id;

  INSERT INTO public.pending_profile_changes (
    user_id, field, new_value, verification_code_id, requested_at, expires_at
  )
  VALUES (p_user_id, p_field, p_new_value, v_code_id, now(), now() + INTERVAL '10 minutes')
  ON CONFLICT (user_id) DO UPDATE
    SET field = EXCLUDED.field,
        new_value = EXCLUDED.new_value,
        verification_code_id = EXCLUDED.verification_code_id,
        requested_at = EXCLUDED.requested_at,
        expires_at = EXCLUDED.expires_at;

  RETURN jsonb_build_object('ok', true, 'verification_code_id', v_code_id);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.create_profile_change_verification(UUID, TEXT, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_profile_change_verification(UUID, TEXT, TEXT, TEXT, TEXT)
  TO service_role;

CREATE OR REPLACE FUNCTION public.verify_and_consume_profile_change(
  p_user_id UUID,
  p_field TEXT,
  p_code TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_pending public.pending_profile_changes%ROWTYPE;
  v_code public.email_verification_codes%ROWTYPE;
BEGIN
  SELECT * INTO v_pending
    FROM public.pending_profile_changes
   WHERE user_id = p_user_id AND field = p_field
   FOR UPDATE;

  IF v_pending.user_id IS NULL THEN
    RETURN jsonb_build_object('valid', false, 'locked', false, 'error', 'NOT_FOUND');
  END IF;

  SELECT * INTO v_code
    FROM public.email_verification_codes
   WHERE id = v_pending.verification_code_id
     AND user_id = p_user_id
     AND target = v_pending.new_value
     AND purpose = CASE p_field WHEN 'email' THEN 'change_email' ELSE 'change_phone' END
     AND used_at IS NULL
   FOR UPDATE;

  IF v_code.id IS NULL THEN
    RETURN jsonb_build_object('valid', false, 'locked', false, 'error', 'NOT_FOUND');
  END IF;

  IF v_pending.expires_at < now() OR v_code.expires_at < now() THEN
    RETURN jsonb_build_object('valid', false, 'locked', false, 'error', 'EXPIRED');
  END IF;

  IF v_code.attempts >= v_code.max_attempts THEN
    RETURN jsonb_build_object('valid', false, 'locked', true, 'attempts_remaining', 0);
  END IF;

  IF v_code.code_hash = crypt(p_code, v_code.code_hash) THEN
    UPDATE public.email_verification_codes SET used_at = now() WHERE id = v_code.id;
    DELETE FROM public.pending_profile_changes
     WHERE user_id = p_user_id AND verification_code_id = v_code.id;
    RETURN jsonb_build_object('valid', true, 'locked', false, 'new_value', v_pending.new_value);
  END IF;

  UPDATE public.email_verification_codes SET attempts = attempts + 1 WHERE id = v_code.id;
  RETURN jsonb_build_object(
    'valid', false,
    'locked', (v_code.attempts + 1) >= v_code.max_attempts,
    'attempts_remaining', GREATEST(v_code.max_attempts - (v_code.attempts + 1), 0)
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.verify_and_consume_profile_change(UUID, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.verify_and_consume_profile_change(UUID, TEXT, TEXT)
  TO service_role;

CREATE OR REPLACE FUNCTION public.cancel_profile_change_verification(
  p_user_id UUID,
  p_verification_code_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.pending_profile_changes
   WHERE user_id = p_user_id AND verification_code_id = p_verification_code_id;

  DELETE FROM public.email_verification_codes
   WHERE id = p_verification_code_id AND user_id = p_user_id AND used_at IS NULL;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.cancel_profile_change_verification(UUID, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_profile_change_verification(UUID, UUID)
  TO service_role;
