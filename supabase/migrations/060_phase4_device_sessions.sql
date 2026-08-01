-- Kay's Pay Phase 4: privacy-preserving device/session registry.
CREATE TABLE public.device_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL UNIQUE,
  device_id_hash TEXT NOT NULL,
  device_name TEXT NOT NULL CHECK (length(device_name) BETWEEN 1 AND 100),
  platform TEXT NOT NULL CHECK (platform IN ('android', 'ios', 'web', 'unknown')),
  last_active_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_device_sessions_user_active ON public.device_sessions(user_id, last_active_at DESC);
ALTER TABLE public.device_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.device_sessions FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.device_sessions TO service_role;

CREATE FUNCTION public.register_device_session(
  p_user_id UUID, p_session_id TEXT, p_device_id TEXT, p_device_name TEXT, p_platform TEXT
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE v_is_new BOOLEAN; v_hash TEXT;
BEGIN
  IF p_user_id IS NULL OR p_session_id IS NULL OR length(p_session_id) > 200
     OR p_device_id IS NULL OR length(p_device_id) > 200
     OR length(trim(p_device_name)) NOT BETWEEN 1 AND 100
     OR p_platform NOT IN ('android','ios','web','unknown') THEN
    RAISE EXCEPTION 'INVALID_DEVICE_SESSION';
  END IF;
  v_hash := encode(digest(convert_to(p_device_id, 'UTF8'), 'sha256'), 'hex');
  SELECT NOT EXISTS(SELECT 1 FROM public.device_sessions WHERE user_id=p_user_id AND device_id_hash=v_hash)
    INTO v_is_new;
  INSERT INTO public.device_sessions(user_id, session_id, device_id_hash, device_name, platform)
  VALUES(p_user_id, p_session_id, v_hash, trim(p_device_name), p_platform)
  ON CONFLICT(session_id) DO UPDATE SET
    device_id_hash=EXCLUDED.device_id_hash, device_name=EXCLUDED.device_name,
    platform=EXCLUDED.platform, last_active_at=now(), revoked_at=NULL;
  RETURN jsonb_build_object('is_new_device', v_is_new);
END $$;

CREATE FUNCTION public.is_device_session_revoked(p_user_id UUID, p_session_id TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT COALESCE((SELECT revoked_at IS NOT NULL FROM public.device_sessions
    WHERE user_id=p_user_id AND session_id=p_session_id), FALSE)
$$;

CREATE FUNCTION public.list_device_sessions(p_user_id UUID)
RETURNS TABLE(id UUID, device_name TEXT, platform TEXT, last_active_at TIMESTAMPTZ,
              created_at TIMESTAMPTZ, revoked_at TIMESTAMPTZ, internal_session_id TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT d.id,d.device_name,d.platform,d.last_active_at,d.created_at,d.revoked_at,
         d.session_id
  FROM public.device_sessions d WHERE d.user_id=p_user_id ORDER BY d.last_active_at DESC
$$;

CREATE FUNCTION public.revoke_device_session(p_user_id UUID, p_device_session_id UUID, p_current_session_id TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  UPDATE public.device_sessions SET revoked_at=now()
  WHERE id=p_device_session_id AND user_id=p_user_id AND session_id<>p_current_session_id AND revoked_at IS NULL;
  IF FOUND THEN
    INSERT INTO public.security_events(user_id,event_type,severity,source,metadata)
    VALUES(p_user_id,'device_session_revoked','warning','device-sessions','{}');
  END IF;
  RETURN FOUND;
END $$;

CREATE FUNCTION public.revoke_other_device_sessions(p_user_id UUID, p_current_session_id TEXT)
RETURNS INT LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_count INT;
BEGIN
  UPDATE public.device_sessions SET revoked_at=now()
  WHERE user_id=p_user_id AND session_id<>p_current_session_id AND revoked_at IS NULL;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  IF v_count>0 THEN
    INSERT INTO public.security_events(user_id,event_type,severity,source,metadata)
    VALUES(p_user_id,'other_sessions_revoked','warning','device-sessions',jsonb_build_object('count',v_count));
  END IF;
  RETURN v_count;
END $$;

CREATE FUNCTION public.revoke_all_device_sessions(p_user_id UUID)
RETURNS INT LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_count INT;
BEGIN
  UPDATE public.device_sessions SET revoked_at=now()
  WHERE user_id=p_user_id AND revoked_at IS NULL;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  INSERT INTO public.security_events(user_id,event_type,severity,source,metadata)
  VALUES(p_user_id,'password_reset_sessions_revoked','critical','password-reset',jsonb_build_object('count',v_count));
  RETURN v_count;
END $$;

REVOKE EXECUTE ON FUNCTION public.register_device_session(UUID,TEXT,TEXT,TEXT,TEXT) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.is_device_session_revoked(UUID,TEXT) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.list_device_sessions(UUID) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.revoke_device_session(UUID,UUID,TEXT) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.revoke_other_device_sessions(UUID,TEXT) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.revoke_all_device_sessions(UUID) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.register_device_session(UUID,TEXT,TEXT,TEXT,TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.is_device_session_revoked(UUID,TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.list_device_sessions(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.revoke_device_session(UUID,UUID,TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.revoke_other_device_sessions(UUID,TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.revoke_all_device_sessions(UUID) TO service_role;
