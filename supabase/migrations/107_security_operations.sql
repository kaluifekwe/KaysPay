-- Phase 6A: security operations visibility and incident workflow.
-- This migration is observation-only: it does not suspend users, block
-- transactions, or modify wallet balances.

ALTER TABLE public.monitoring_alerts
  ADD COLUMN status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'acknowledged', 'resolved')),
  ADD COLUMN acknowledged_at TIMESTAMPTZ,
  ADD COLUMN acknowledged_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN resolved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN resolution_notes TEXT CHECK (resolution_notes IS NULL OR length(resolution_notes) <= 500),
  ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

UPDATE public.monitoring_alerts
SET status = CASE WHEN resolved_at IS NULL THEN 'open' ELSE 'resolved' END;

DROP INDEX IF EXISTS public.idx_monitoring_alerts_open;
CREATE INDEX idx_monitoring_alerts_status_seen
  ON public.monitoring_alerts(status, last_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_security_events_type_created
  ON public.security_events(event_type, created_at DESC);

CREATE TABLE public.monitoring_health (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  last_success_at TIMESTAMPTZ,
  last_failure_at TIMESTAMPTZ,
  last_email_at TIMESTAMPTZ,
  consecutive_failures INT NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  last_error_code TEXT CHECK (last_error_code IS NULL OR length(last_error_code) <= 64),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO public.monitoring_health(singleton) VALUES(TRUE) ON CONFLICT DO NOTHING;
ALTER TABLE public.monitoring_health ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.monitoring_health FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.monitoring_health TO service_role;

CREATE OR REPLACE FUNCTION public.record_monitoring_health(
  p_success BOOLEAN,
  p_email_sent BOOLEAN DEFAULT FALSE,
  p_error_code TEXT DEFAULT NULL
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF p_error_code IS NOT NULL AND (length(p_error_code)>64 OR p_error_code !~ '^[A-Z0-9_]+$') THEN
    RAISE EXCEPTION 'INVALID_MONITOR_ERROR_CODE';
  END IF;
  INSERT INTO public.monitoring_health(
    singleton,last_success_at,last_failure_at,last_email_at,
    consecutive_failures,last_error_code,updated_at
  ) VALUES (
    TRUE,
    CASE WHEN p_success THEN now() END,
    CASE WHEN NOT p_success THEN now() END,
    CASE WHEN p_email_sent THEN now() END,
    CASE WHEN p_success THEN 0 ELSE 1 END,
    CASE WHEN p_success THEN NULL ELSE p_error_code END,
    now()
  ) ON CONFLICT(singleton) DO UPDATE SET
    last_success_at=CASE WHEN p_success THEN now() ELSE public.monitoring_health.last_success_at END,
    last_failure_at=CASE WHEN NOT p_success THEN now() ELSE public.monitoring_health.last_failure_at END,
    last_email_at=CASE WHEN p_email_sent THEN now() ELSE public.monitoring_health.last_email_at END,
    consecutive_failures=CASE WHEN p_success THEN 0 ELSE public.monitoring_health.consecutive_failures+1 END,
    last_error_code=CASE WHEN p_success THEN NULL ELSE p_error_code END,
    updated_at=now();
END;
$$;
REVOKE EXECUTE ON FUNCTION public.record_monitoring_health(BOOLEAN,BOOLEAN,TEXT) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.record_monitoring_health(BOOLEAN,BOOLEAN,TEXT) TO service_role;

-- Preserve the existing alert cooldown while reopening a recurring finding.
CREATE OR REPLACE FUNCTION public.record_monitoring_alert(
  p_fingerprint TEXT,
  p_type TEXT,
  p_severity TEXT,
  p_details JSONB
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public
AS $$
DECLARE v_should_email BOOLEAN;
BEGIN
  IF p_fingerprint !~ '^[a-z0-9_-]{3,100}$'
     OR p_severity NOT IN ('warning','critical')
     OR length(COALESCE(p_details,'{}')::TEXT)>2048 THEN
    RAISE EXCEPTION 'INVALID_MONITORING_ALERT';
  END IF;

  INSERT INTO public.monitoring_alerts(
    fingerprint, alert_type, severity, details, last_alerted_at
  ) VALUES (
    p_fingerprint, p_type, p_severity, COALESCE(p_details,'{}'), now()
  )
  ON CONFLICT(fingerprint) DO UPDATE SET
    occurrence_count = public.monitoring_alerts.occurrence_count + 1,
    alert_type = EXCLUDED.alert_type,
    severity = EXCLUDED.severity,
    details = EXCLUDED.details,
    last_seen_at = now(),
    status = CASE
      WHEN public.monitoring_alerts.status='acknowledged' THEN 'acknowledged'
      ELSE 'open'
    END,
    acknowledged_at = CASE
      WHEN public.monitoring_alerts.status='acknowledged' THEN public.monitoring_alerts.acknowledged_at
      ELSE NULL
    END,
    acknowledged_by = CASE
      WHEN public.monitoring_alerts.status='acknowledged' THEN public.monitoring_alerts.acknowledged_by
      ELSE NULL
    END,
    resolved_at = NULL,
    resolved_by = NULL,
    resolution_notes = NULL,
    updated_at = now(),
    last_alerted_at = CASE
      WHEN public.monitoring_alerts.last_alerted_at < now() - INTERVAL '6 hours'
        THEN now()
      ELSE public.monitoring_alerts.last_alerted_at
    END
  RETURNING last_alerted_at > now() - INTERVAL '5 seconds'
    INTO v_should_email;
  RETURN v_should_email;
END;
$$;

-- Add transaction-PIN failures and lockouts to the unified audit stream.
-- No PIN, hash, token, email, phone number, or IP address is recorded.
CREATE OR REPLACE FUNCTION public.verify_user_pin(p_pin TEXT, p_max_uses INT DEFAULT 1)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_row user_pins%ROWTYPE;
  v_max INT := 5;
  v_lock_mins INT := 15;
  v_token TEXT;
  v_ttl_secs INT;
  v_expires_at TIMESTAMPTZ;
  v_unlocked_after_lockout BOOLEAN := FALSE;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;

  SELECT * INTO v_row FROM user_pins WHERE user_id = v_uid FOR UPDATE;
  IF v_row.user_id IS NULL THEN
    RETURN jsonb_build_object('valid', false, 'locked', false, 'error', 'NO_PIN_SET');
  END IF;

  IF v_row.locked_until IS NOT NULL AND v_row.locked_until > now() THEN
    RETURN jsonb_build_object(
      'valid', false, 'locked', true,
      'locked_until', v_row.locked_until, 'attempts_remaining', 0
    );
  END IF;

  v_unlocked_after_lockout := v_row.locked_until IS NOT NULL;

  IF v_row.pin_hash = crypt(p_pin, v_row.pin_hash) THEN
    UPDATE user_pins SET attempts=0, locked_until=NULL, updated_at=now()
      WHERE user_id=v_uid;

    IF v_unlocked_after_lockout THEN
      INSERT INTO public.security_events(user_id,event_type,severity,source,metadata)
      VALUES(v_uid,'transaction_pin_unlock_after_lockout','info','transaction-pin','{}');
    END IF;

    DELETE FROM transaction_auth_tokens WHERE user_id=v_uid AND expires_at<now();
    v_token := encode(gen_random_bytes(32), 'hex');
    v_ttl_secs := 180 + (GREATEST(COALESCE(p_max_uses,1),1)-1)*3;
    v_expires_at := now() + make_interval(secs=>v_ttl_secs);
    INSERT INTO transaction_auth_tokens(token,user_id,max_uses,expires_at)
    VALUES(v_token,v_uid,GREATEST(COALESCE(p_max_uses,1),1),v_expires_at);
    RETURN jsonb_build_object(
      'valid',true,'locked',false,'token',v_token,'expires_at',v_expires_at
    );
  END IF;

  IF v_row.attempts + 1 >= v_max THEN
    UPDATE user_pins
      SET attempts=0, locked_until=now()+make_interval(mins=>v_lock_mins), updated_at=now()
      WHERE user_id=v_uid;
    INSERT INTO public.security_events(user_id,event_type,severity,source,metadata)
    VALUES(
      v_uid,'transaction_pin_lockout','warning','transaction-pin',
      jsonb_build_object('max_attempts',v_max,'lock_minutes',v_lock_mins)
    );
    RETURN jsonb_build_object(
      'valid',false,'locked',true,
      'locked_until',now()+make_interval(mins=>v_lock_mins),'attempts_remaining',0
    );
  END IF;

  UPDATE user_pins SET attempts=v_row.attempts+1, updated_at=now()
    WHERE user_id=v_uid;
  INSERT INTO public.security_events(user_id,event_type,severity,source,metadata)
  VALUES(
    v_uid,'transaction_pin_failed','warning','transaction-pin',
    jsonb_build_object('attempts_remaining',v_max-(v_row.attempts+1))
  );
  RETURN jsonb_build_object(
    'valid',false,'locked',false,
    'attempts_remaining',v_max-(v_row.attempts+1)
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.verify_user_pin(TEXT, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.verify_user_pin(TEXT, INT) TO authenticated, service_role;

-- Mirror the existing PIN-reset audit record into the unified event stream.
CREATE OR REPLACE FUNCTION public.mirror_security_audit_event()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  INSERT INTO public.security_events(user_id,event_type,severity,source,metadata)
  VALUES(NEW.user_id,NEW.event,'warning','pin-reset',NEW.metadata);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_mirror_security_audit_event ON public.security_audit_log;
CREATE TRIGGER trg_mirror_security_audit_event
AFTER INSERT ON public.security_audit_log
FOR EACH ROW EXECUTE FUNCTION public.mirror_security_audit_event();
REVOKE EXECUTE ON FUNCTION public.mirror_security_audit_event() FROM PUBLIC,anon,authenticated;

-- Log only genuinely new physical devices. The stored identifier is already
-- SHA-256 hashed and is never returned by the admin API.
CREATE OR REPLACE FUNCTION public.register_device_session(
  p_user_id UUID, p_session_id TEXT, p_device_id TEXT,
  p_device_name TEXT, p_platform TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,extensions AS $$
DECLARE v_is_new BOOLEAN; v_hash TEXT;
BEGIN
  IF p_user_id IS NULL OR p_session_id IS NULL OR length(p_session_id)>200
     OR p_device_id IS NULL OR length(p_device_id)>200
     OR length(trim(p_device_name)) NOT BETWEEN 1 AND 100
     OR p_platform NOT IN ('android','ios','web','unknown') THEN
    RAISE EXCEPTION 'INVALID_DEVICE_SESSION';
  END IF;
  v_hash := encode(digest(convert_to(p_device_id,'UTF8'),'sha256'),'hex');
  SELECT NOT EXISTS(
    SELECT 1 FROM public.device_sessions
    WHERE user_id=p_user_id AND device_id_hash=v_hash
  ) INTO v_is_new;

  INSERT INTO public.device_sessions(user_id,session_id,device_id_hash,device_name,platform)
  VALUES(p_user_id,p_session_id,v_hash,trim(p_device_name),p_platform)
  ON CONFLICT(user_id,device_id_hash) DO UPDATE SET
    session_id=EXCLUDED.session_id,
    device_name=EXCLUDED.device_name,
    platform=EXCLUDED.platform,
    last_active_at=now(),
    revoked_at=NULL;

  IF v_is_new THEN
    INSERT INTO public.security_events(user_id,event_type,severity,source,metadata)
    VALUES(
      p_user_id,'device_session_registered','info','device-sessions',
      jsonb_build_object('device_hash',v_hash,'platform',p_platform)
    );
  END IF;
  RETURN jsonb_build_object('is_new_device',v_is_new);
END;
$$;

-- Existing financial checks plus bounded security-operation indicators.
CREATE OR REPLACE FUNCTION public.collect_financial_integrity_metrics()
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT jsonb_build_object(
    'negative_wallets',(SELECT count(*) FROM public.wallets WHERE balance<0 OR locked_amount<0 OR locked_amount>balance),
    'stuck_vtu',(SELECT count(*) FROM public.transactions WHERE status='pending' AND type IN ('airtime','data','bill','exam_pin') AND created_at<now()-INTERVAL '20 minutes'),
    'stuck_foreign_numbers',(SELECT count(*) FROM public.transactions WHERE status='pending' AND type='foreign_number' AND created_at<now()-INTERVAL '30 minutes'),
    'stuck_identity',(SELECT count(*) FROM public.transactions WHERE status='pending' AND type IN ('nin_validation','nin_name_modification','nin_phone_modification','nin_address_modification') AND created_at<now()-INTERVAL '72 hours'),
    'duplicate_provider_refs',(SELECT count(*) FROM (SELECT vtu_order_id FROM public.transactions WHERE vtu_order_id IS NOT NULL AND type IN ('airtime','data','bill','exam_pin','esim','foreign_number') AND created_at>now()-INTERVAL '30 days' GROUP BY vtu_order_id HAVING count(*)>1) d),
    'unsafe_grants',(SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prosecdef AND 'p_user_id'=ANY(p.proargnames) AND (has_function_privilege('anon',p.oid,'EXECUTE') OR has_function_privilege('authenticated',p.oid,'EXECUTE'))),
    'funding_unresolved',(SELECT count(*) FROM public.funding_events WHERE status IN ('received','unmatched','error') AND last_seen_at<now()-INTERVAL '4 minutes'),
    'funding_reconcile_stale',(SELECT count(*) FROM public.funding_reconciliation_state WHERE last_run_at IS NULL OR last_run_at<now()-INTERVAL '15 minutes'),
    'funding_reconcile_errors',(SELECT count(*) FROM public.funding_reconciliation_state WHERE last_error IS NOT NULL),
    'pending_total',(SELECT count(*) FROM public.transactions WHERE status='pending'),
    'completed_24h',(SELECT count(*) FROM public.transactions WHERE status='completed' AND created_at>now()-INTERVAL '24 hours'),
    'failed_24h',(SELECT count(*) FROM public.transactions WHERE status='failed' AND created_at>now()-INTERVAL '24 hours'),
    'refunded_24h',(SELECT count(*) FROM public.transactions WHERE status='refunded' AND created_at>now()-INTERVAL '24 hours'),
    'volume_kobo_24h',(SELECT COALESCE(sum(amount_ngn),0) FROM public.transactions WHERE status='completed' AND created_at>now()-INTERVAL '24 hours'),
    'burst_accounts',(SELECT count(*) FROM (SELECT user_id FROM public.transactions WHERE created_at>now()-INTERVAL '1 hour' GROUP BY user_id HAVING count(*)>50) b),
    'repeated_pin_lockouts',(SELECT count(*) FROM (SELECT user_id FROM public.security_events WHERE event_type='transaction_pin_lockout' AND created_at>now()-INTERVAL '24 hours' AND user_id IS NOT NULL GROUP BY user_id HAVING count(*)>=3) s),
    'repeated_pin_resets',(SELECT count(*) FROM (SELECT user_id FROM public.security_events WHERE event_type='transaction_pin_reset' AND created_at>now()-INTERVAL '24 hours' AND user_id IS NOT NULL GROUP BY user_id HAVING count(*)>=2) s),
    'repeated_admin_denials',(SELECT count(*) FROM (SELECT user_id FROM public.security_events WHERE event_type='admin_auth_denied' AND created_at>now()-INTERVAL '15 minutes' AND user_id IS NOT NULL GROUP BY user_id HAVING count(*)>=5) s),
    'shared_device_accounts',(SELECT count(*) FROM (SELECT metadata->>'device_hash' AS device_hash FROM public.security_events WHERE event_type='device_session_registered' AND created_at>now()-INTERVAL '30 days' AND metadata ? 'device_hash' GROUP BY metadata->>'device_hash' HAVING count(DISTINCT user_id)>=3) s),
    'excessive_new_devices',(SELECT count(*) FROM (SELECT user_id FROM public.security_events WHERE event_type='device_session_registered' AND created_at>now()-INTERVAL '24 hours' AND user_id IS NOT NULL GROUP BY user_id HAVING count(*)>=5) s)
  )
$$;

REVOKE EXECUTE ON FUNCTION public.collect_financial_integrity_metrics() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.collect_financial_integrity_metrics() TO service_role;
