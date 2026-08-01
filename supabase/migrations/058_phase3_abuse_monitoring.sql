-- Kay's Pay Phase 3: account-scoped abuse prevention and security monitoring

CREATE TABLE public.abuse_rate_limits (
  scope TEXT NOT NULL,
  subject_hash TEXT NOT NULL,
  window_bucket BIGINT NOT NULL,
  request_count INT NOT NULL DEFAULT 1 CHECK (request_count > 0),
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (scope, subject_hash, window_bucket)
);

CREATE INDEX idx_abuse_rate_limits_expiry ON public.abuse_rate_limits (expires_at);
ALTER TABLE public.abuse_rate_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.abuse_rate_limits FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.abuse_rate_limits TO service_role;

CREATE TABLE public.security_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL CHECK (event_type ~ '^[a-z0-9_]{3,64}$'),
  severity TEXT NOT NULL DEFAULT 'warning' CHECK (severity IN ('info', 'warning', 'critical')),
  source TEXT NOT NULL CHECK (source ~ '^[a-z0-9_-]{2,64}$'),
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (length(metadata::TEXT) <= 2048)
);

CREATE INDEX idx_security_events_created ON public.security_events (created_at DESC);
CREATE INDEX idx_security_events_user_created ON public.security_events (user_id, created_at DESC);
ALTER TABLE public.security_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.security_events FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.security_events TO service_role;

CREATE FUNCTION public.enforce_abuse_rate_limit(
  p_scope TEXT,
  p_subject TEXT,
  p_max_requests INT,
  p_window_seconds INT,
  p_user_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bucket BIGINT;
  v_count INT;
  v_retry_after INT;
  v_subject_hash TEXT;
BEGIN
  IF p_scope !~ '^[a-z0-9_-]{2,64}$'
     OR p_subject IS NULL OR length(p_subject) NOT BETWEEN 1 AND 256
     OR p_max_requests NOT BETWEEN 1 AND 10000
     OR p_window_seconds NOT BETWEEN 10 AND 86400 THEN
    RAISE EXCEPTION 'INVALID_RATE_LIMIT_CONFIG';
  END IF;

  v_bucket := floor(extract(epoch FROM clock_timestamp()) / p_window_seconds);
  v_retry_after := p_window_seconds - (extract(epoch FROM clock_timestamp())::BIGINT % p_window_seconds);
  v_subject_hash := encode(digest(convert_to(p_subject, 'UTF8'), 'sha256'), 'hex');

  INSERT INTO public.abuse_rate_limits(scope, subject_hash, window_bucket, request_count, expires_at)
  VALUES (p_scope, v_subject_hash, v_bucket, 1, now() + make_interval(secs => p_window_seconds * 2))
  ON CONFLICT (scope, subject_hash, window_bucket) DO UPDATE
    SET request_count = public.abuse_rate_limits.request_count + 1
  RETURNING request_count INTO v_count;

  -- Emit once per subject/window, not once per rejected request. Otherwise an
  -- attacker could turn the monitoring control itself into a write-amplifier.
  IF v_count = p_max_requests + 1 THEN
    INSERT INTO public.security_events(user_id, event_type, severity, source, metadata)
    VALUES (p_user_id, 'rate_limit_exceeded', 'warning', p_scope,
            jsonb_build_object('limit', p_max_requests, 'window_seconds', p_window_seconds));
  END IF;

  -- Small bounded opportunistic cleanup; normal requests never scan the table.
  IF random() < 0.01 THEN
    DELETE FROM public.abuse_rate_limits
    WHERE ctid IN (SELECT ctid FROM public.abuse_rate_limits WHERE expires_at < now() LIMIT 500);
    DELETE FROM public.security_events
    WHERE id IN (SELECT id FROM public.security_events WHERE created_at < now() - INTERVAL '180 days' LIMIT 500);
  END IF;

  RETURN jsonb_build_object(
    'allowed', v_count <= p_max_requests,
    'remaining', GREATEST(p_max_requests - v_count, 0),
    'retry_after_seconds', CASE WHEN v_count > p_max_requests THEN v_retry_after ELSE 0 END
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.enforce_abuse_rate_limit(TEXT, TEXT, INT, INT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enforce_abuse_rate_limit(TEXT, TEXT, INT, INT, UUID) TO service_role;

-- Security-definer privilege assertions: clients can neither inspect events
-- nor invoke the limiter with attacker-chosen subjects.
DO $$
BEGIN
  IF has_table_privilege('authenticated', 'public.security_events', 'SELECT') THEN
    RAISE EXCEPTION 'SECURITY_ASSERTION_FAILED: client can read security events';
  END IF;
  IF has_function_privilege('authenticated', 'public.enforce_abuse_rate_limit(text,text,integer,integer,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'SECURITY_ASSERTION_FAILED: client can invoke rate limiter';
  END IF;
END $$;
