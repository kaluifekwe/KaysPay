-- Active Sessions bug fix (2026-08-07). Two problems, one root cause:
-- register_device_session upserted on session_id (unique per LOGIN, and
-- Supabase mints a new one on more events than expected — every app
-- relaunch, every silent token refresh) instead of on the physical device
-- itself. Every re-registration of the SAME phone therefore inserted a
-- brand new row rather than updating one — exactly the growing list of
-- identical device names a tester reported seeing.
--
-- Also: list_device_sessions never excluded revoked rows, so tapping
-- "Remove" correctly marked a row revoked_at server-side but it kept
-- showing in the list (just missing its button) instead of disappearing,
-- which is what "Remove" should visibly do.

-- 1) Dedupe existing rows before adding the new uniqueness constraint —
-- keep only the most-recently-active row per (user, physical device).
DELETE FROM public.device_sessions d
WHERE EXISTS (
  SELECT 1 FROM public.device_sessions d2
  WHERE d2.user_id = d.user_id AND d2.device_id_hash = d.device_id_hash
    AND (d2.last_active_at, d2.id) > (d.last_active_at, d.id)
);

-- 2) One row per (user, physical device) going forward.
ALTER TABLE public.device_sessions
  ADD CONSTRAINT device_sessions_user_device_unique UNIQUE (user_id, device_id_hash);

-- 3) Re-registering the SAME device (new session_id from a relaunch/token
-- refresh) now updates that one row instead of inserting another.
CREATE OR REPLACE FUNCTION public.register_device_session(
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
  ON CONFLICT(user_id, device_id_hash) DO UPDATE SET
    session_id=EXCLUDED.session_id, device_name=EXCLUDED.device_name,
    platform=EXCLUDED.platform, last_active_at=now(), revoked_at=NULL;
  RETURN jsonb_build_object('is_new_device', v_is_new);
END $$;

-- 4) A removed device now actually leaves the list instead of lingering
-- with just its Remove button hidden. The revoke event itself is still
-- kept forever in security_events, so nothing is lost for audit purposes.
CREATE OR REPLACE FUNCTION public.list_device_sessions(p_user_id UUID)
RETURNS TABLE(id UUID, device_name TEXT, platform TEXT, last_active_at TIMESTAMPTZ,
              created_at TIMESTAMPTZ, revoked_at TIMESTAMPTZ, internal_session_id TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT d.id,d.device_name,d.platform,d.last_active_at,d.created_at,d.revoked_at,
         d.session_id
  FROM public.device_sessions d
  WHERE d.user_id=p_user_id AND d.revoked_at IS NULL
  ORDER BY d.last_active_at DESC
$$;
