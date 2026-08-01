-- Kay's Pay Phase 2: database authorization and least privilege
-- =====================================================================
-- 1. PIN changes require a freshly verified current PIN/biometric token.
-- 2. Client analytics writes are validated and rate-limited server-side.
-- 3. SECURITY DEFINER functions lose implicit PUBLIC/anon execution.
-- 4. Table privileges are explicit, with server-only tables inaccessible.

-- Replace the original one-argument function. The default keeps first-time
-- onboarding calls compatible; an existing PIN can only be replaced using a
-- one-time step-up token minted by verify_user_pin.
DROP FUNCTION IF EXISTS public.set_user_pin(TEXT);

CREATE FUNCTION public.set_user_pin(p_pin TEXT, p_auth_token TEXT DEFAULT NULL)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_has_pin BOOLEAN;
  v_auth_token TEXT := p_auth_token;
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
    -- Compatibility for the currently installed production client: it already
    -- verifies the old PIN immediately before this call, but did not yet pass
    -- the returned token. Consume that user's newest valid unused token. New
    -- clients pass the token explicitly, avoiding any ambiguity.
    IF v_auth_token IS NULL THEN
      SELECT token INTO v_auth_token
      FROM public.transaction_auth_tokens
      WHERE user_id = v_uid AND expires_at > now() AND uses_count < max_uses
      ORDER BY created_at DESC
      LIMIT 1;
    END IF;

    IF NOT public.consume_transaction_auth_token(v_uid, v_auth_token) THEN
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

-- Replace direct client inserts with a bounded RPC. This prevents a valid
-- account from filling the database with unlimited or oversized log rows.
DROP POLICY IF EXISTS "Users can insert own logs" ON public.service_logs;
REVOKE INSERT, UPDATE, DELETE ON public.service_logs FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.log_service_event(
  p_service_type TEXT,
  p_provider TEXT,
  p_action TEXT,
  p_metadata JSONB DEFAULT NULL,
  p_device_info TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_recent_count INT;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;
  IF p_service_type NOT IN ('airtime', 'data', 'bill', 'exam_pin', 'tv', 'wallet_fund', 'foreign_number', 'dollar_card') THEN
    RAISE EXCEPTION 'INVALID_SERVICE_TYPE';
  END IF;
  IF p_action NOT IN ('view', 'attempt', 'success', 'failure') THEN
    RAISE EXCEPTION 'INVALID_ACTION';
  END IF;
  IF length(COALESCE(p_provider, '')) > 64
     OR length(COALESCE(p_device_info, '')) > 128
     OR length(COALESCE(p_metadata::TEXT, '')) > 4096 THEN
    RAISE EXCEPTION 'LOG_PAYLOAD_TOO_LARGE';
  END IF;

  SELECT count(*) INTO v_recent_count
  FROM public.service_logs
  WHERE user_id = v_uid AND created_at > now() - INTERVAL '1 hour';

  IF v_recent_count >= 120 THEN RETURN FALSE; END IF;

  INSERT INTO public.service_logs (
    user_id, service_type, provider, action, metadata, network_type, device_info
  ) VALUES (
    v_uid, p_service_type, NULLIF(p_provider, ''), p_action, p_metadata, NULL,
    NULLIF(p_device_info, '')
  );
  RETURN TRUE;
END;
$$;

-- No unauthenticated role needs direct access to app tables.
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM anon;

-- Authenticated users receive only the table reads used by the app. All
-- writes flow through owner-scoped Auth APIs or vetted RPC/Edge Functions.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON ALL TABLES IN SCHEMA public FROM authenticated;
GRANT SELECT ON TABLE
  public.users,
  public.wallets,
  public.transactions,
  public.withdrawals,
  public.service_logs,
  public.virtual_accounts,
  public.user_kyc,
  public.notifications
TO authenticated;

-- Defense in depth for tables that contain hashes, tokens, provider state,
-- idempotency records, rate-limit data, or internal catalog/job state.
REVOKE ALL ON TABLE
  public.processed_payments,
  public.user_pins,
  public.vtu_ng_auth,
  public.airalo_auth,
  public.transaction_auth_tokens,
  public.flutterwave_auth,
  public.cron_job_locks,
  public.email_verification_codes,
  public.kyc_attempts,
  public.fx_rates,
  public.esim_catalog,
  public.push_tokens,
  public.smspva_price_cache
FROM anon, authenticated;

-- PostgreSQL grants EXECUTE to PUBLIC by default. Remove that implicit access
-- from every privileged public function, then restore only the small client
-- allowlist. service_role remains explicitly able to call all of them.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS signature
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prosecdef
  LOOP
    EXECUTE 'REVOKE EXECUTE ON FUNCTION ' || r.signature || ' FROM PUBLIC, anon, authenticated';
    EXECUTE 'GRANT EXECUTE ON FUNCTION ' || r.signature || ' TO service_role';
  END LOOP;
END $$;

GRANT EXECUTE ON FUNCTION public.set_user_pin(TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.verify_user_pin(TEXT, INT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_user_pin() TO authenticated;
GRANT EXECUTE ON FUNCTION public.mark_notification_read(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mark_all_notifications_read() TO authenticated;
GRANT EXECUTE ON FUNCTION public.register_push_token(TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.log_service_event(TEXT, TEXT, TEXT, JSONB, TEXT) TO authenticated;

-- Deployment-time regression assertions. Abort and roll back the migration if
-- a future default privilege or signature change reopens these boundaries.
DO $$
BEGIN
  IF has_function_privilege('anon', 'public.set_user_pin(text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'SECURITY_ASSERTION_FAILED: anon can set PIN';
  END IF;
  IF has_function_privilege('authenticated', 'public.credit_wallet_funding(uuid,text,bigint,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'SECURITY_ASSERTION_FAILED: client can credit wallet';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.verify_user_pin(text,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'SECURITY_ASSERTION_FAILED: PIN verification unavailable';
  END IF;
  IF has_table_privilege('anon', 'public.wallets', 'SELECT') THEN
    RAISE EXCEPTION 'SECURITY_ASSERTION_FAILED: anon can read wallets';
  END IF;
  IF has_table_privilege('authenticated', 'public.user_pins', 'SELECT') THEN
    RAISE EXCEPTION 'SECURITY_ASSERTION_FAILED: client can read PIN hashes';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.transactions', 'SELECT') THEN
    RAISE EXCEPTION 'SECURITY_ASSERTION_FAILED: transaction history unavailable';
  END IF;
END $$;
