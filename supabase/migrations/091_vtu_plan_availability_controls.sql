-- Server-authoritative VTUnaija data availability controls.
ALTER TABLE public.vtunaija_data_catalog
  ADD COLUMN IF NOT EXISTS family_key TEXT NOT NULL DEFAULT 'other',
  ADD COLUMN IF NOT EXISTS family_name TEXT NOT NULL DEFAULT 'Other';

CREATE TABLE IF NOT EXISTS public.vtu_plan_controls (
  provider TEXT NOT NULL CHECK (provider = 'vtunaija'),
  network TEXT NOT NULL CHECK (network IN ('mtn','glo','9mobile','airtel')),
  scope_type TEXT NOT NULL CHECK (scope_type IN ('network','family','plan')),
  scope_value TEXT NOT NULL CHECK (length(scope_value) BETWEEN 1 AND 160),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  reason TEXT,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','automatic')),
  updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, network, scope_type, scope_value),
  CHECK (enabled OR length(trim(COALESCE(reason, ''))) >= 3)
);

CREATE INDEX IF NOT EXISTS idx_vtu_plan_controls_disabled
  ON public.vtu_plan_controls(provider, network, scope_type, scope_value)
  WHERE enabled = false;

ALTER TABLE public.vtu_plan_controls ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.vtu_plan_controls FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.vtu_plan_controls TO service_role;

CREATE OR REPLACE FUNCTION public.is_vtu_plan_enabled(
  p_provider TEXT,
  p_network TEXT,
  p_family_key TEXT,
  p_plan_id TEXT
) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM public.vtu_plan_controls c
    WHERE c.provider = p_provider
      AND c.network = p_network
      AND c.enabled = false
      AND (
        (c.scope_type = 'network' AND c.scope_value = '*') OR
        (c.scope_type = 'family' AND c.scope_value = p_family_key) OR
        (c.scope_type = 'plan' AND c.scope_value = p_plan_id)
      )
  )
$$;

CREATE OR REPLACE FUNCTION public.auto_disable_vtu_plan(
  p_provider TEXT,
  p_network TEXT,
  p_plan_id TEXT,
  p_reason TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_provider <> 'vtunaija'
     OR p_network NOT IN ('mtn','glo','9mobile','airtel')
     OR p_plan_id !~ '^vtunaija-(mtn|glo|9mobile|airtel)-[0-9]+$'
     OR length(trim(COALESCE(p_reason, ''))) < 3 THEN
    RETURN FALSE;
  END IF;
  INSERT INTO public.vtu_plan_controls(
    provider, network, scope_type, scope_value, enabled, reason, source, updated_at
  ) VALUES (
    p_provider, p_network, 'plan', p_plan_id, false, left(trim(p_reason), 500), 'automatic', now()
  )
  ON CONFLICT(provider, network, scope_type, scope_value) DO UPDATE SET
    enabled = false, reason = EXCLUDED.reason, source = 'automatic', updated_by = NULL, updated_at = now();
  RETURN TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_vtu_plan_control(
  p_admin_user_id UUID,
  p_provider TEXT,
  p_network TEXT,
  p_scope_type TEXT,
  p_scope_value TEXT,
  p_enabled BOOLEAN,
  p_reason TEXT
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_provider <> 'vtunaija'
     OR p_network NOT IN ('mtn','glo','9mobile','airtel')
     OR p_scope_type NOT IN ('network','family','plan')
     OR length(p_scope_value) NOT BETWEEN 1 AND 160
     OR (p_scope_type = 'network' AND p_scope_value <> '*')
     OR (NOT p_enabled AND length(trim(COALESCE(p_reason, ''))) < 3) THEN
    RAISE EXCEPTION 'INVALID_VTU_PLAN_CONTROL';
  END IF;

  INSERT INTO public.vtu_plan_controls(
    provider, network, scope_type, scope_value, enabled, reason, source, updated_by, updated_at
  ) VALUES (
    p_provider, p_network, p_scope_type, p_scope_value, p_enabled,
    NULLIF(left(trim(COALESCE(p_reason, '')), 500), ''), 'manual', p_admin_user_id, now()
  )
  ON CONFLICT(provider, network, scope_type, scope_value) DO UPDATE SET
    enabled = EXCLUDED.enabled, reason = EXCLUDED.reason, source = 'manual',
    updated_by = EXCLUDED.updated_by, updated_at = now();

  INSERT INTO public.admin_actions(
    admin_user_id, action_type, target_type, target_id, reason, metadata
  ) VALUES (
    p_admin_user_id, 'vtu_plan_control_toggle', 'vtu_plan_controls',
    concat(p_network, ':', p_scope_type, ':', p_scope_value),
    NULLIF(left(trim(COALESCE(p_reason, '')), 500), ''),
    jsonb_build_object(
      'provider', p_provider, 'network', p_network, 'scope_type', p_scope_type,
      'scope_value', p_scope_value, 'enabled', p_enabled
    )
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.is_vtu_plan_enabled(TEXT,TEXT,TEXT,TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.auto_disable_vtu_plan(TEXT,TEXT,TEXT,TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.set_vtu_plan_control(UUID,TEXT,TEXT,TEXT,TEXT,BOOLEAN,TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_vtu_plan_enabled(TEXT,TEXT,TEXT,TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.auto_disable_vtu_plan(TEXT,TEXT,TEXT,TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.set_vtu_plan_control(UUID,TEXT,TEXT,TEXT,TEXT,BOOLEAN,TEXT) TO service_role;
