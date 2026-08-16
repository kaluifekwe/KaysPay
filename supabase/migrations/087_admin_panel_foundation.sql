-- Admin panel foundation (2026-08-07). Two new tables plus two read-only
-- aggregate RPCs. No existing table is touched — every admin-facing
-- read/write beyond get_my_admin_role() goes through service-role edge
-- functions (see supabase/functions/admin-*), never direct client RLS
-- access to transactions/users/wallets, matching this project's existing
-- convention for every other sensitive table.

CREATE TABLE public.admin_users (
  user_id     UUID PRIMARY KEY REFERENCES auth.users(id),
  role        TEXT NOT NULL CHECK (role IN ('support','super_admin')),
  invited_by  UUID REFERENCES auth.users(id),
  disabled_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Records who did what through the admin panel. audit_log (migration 084)
-- already captures *what changed* on transactions via trigger; this table
-- is the complementary "who initiated it" record for admin-driven actions
-- specifically (starting with kill-switch toggles; refunds reuse this
-- unchanged in a later phase).
CREATE TABLE public.admin_actions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id UUID NOT NULL REFERENCES auth.users(id),
  action_type   TEXT NOT NULL,
  target_type   TEXT,
  target_id     TEXT,
  reason        TEXT,
  metadata      JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (length(metadata::TEXT) <= 1024),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_admin_actions_created_at ON public.admin_actions(created_at DESC);

ALTER TABLE public.admin_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_actions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.admin_users, public.admin_actions FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.admin_users, public.admin_actions TO service_role;

-- The one thing a logged-in user may check about themselves directly —
-- purely informational (lets the admin app pick which nav to render
-- without a round trip), never a security boundary. Every actual admin
-- operation re-checks admin_users authoritatively inside its own edge
-- function via requireAdmin().
CREATE FUNCTION public.get_my_admin_role() RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT role FROM public.admin_users WHERE user_id = auth.uid() AND disabled_at IS NULL
$$;
REVOKE EXECUTE ON FUNCTION public.get_my_admin_role() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_admin_role() TO authenticated;

-- Lets the login screen tell "nobody is an admin yet, show the one-time
-- bootstrap screen" apart from "admins already exist, you're just not one
-- of them" — reveals only a yes/no, never who the existing admins are.
CREATE FUNCTION public.admin_panel_needs_bootstrap() RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT NOT EXISTS (SELECT 1 FROM public.admin_users)
$$;
REVOKE EXECUTE ON FUNCTION public.admin_panel_needs_bootstrap() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_panel_needs_bootstrap() TO authenticated;

-- Atomic check-then-insert so two near-simultaneous bootstrap calls from
-- different accounts can't both succeed (the edge function alone can't
-- guarantee this across two separate round trips). LOCK TABLE serializes
-- concurrent callers within this single transaction; only the first ever
-- returns TRUE.
CREATE FUNCTION public.bootstrap_admin(p_user_id UUID) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  LOCK TABLE public.admin_users IN EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM public.admin_users) THEN
    RETURN FALSE;
  END IF;
  INSERT INTO public.admin_users(user_id, role) VALUES (p_user_id, 'super_admin');
  RETURN TRUE;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.bootstrap_admin(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bootstrap_admin(UUID) TO service_role;

-- auth.users isn't reachable through PostgREST (no admin.getUserByEmail in
-- supabase-js v2 either), but a SECURITY DEFINER function running inside
-- Postgres can read it directly. Used only by admin-invite's fallback path:
-- when the invited email already belongs to an existing KaysPay account,
-- that person just gets granted admin_users access directly (they already
-- have a password) instead of going through inviteUserByEmail, which only
-- works for brand-new accounts.
CREATE FUNCTION public.admin_lookup_user_id_by_email(p_email TEXT) RETURNS UUID
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
  SELECT id FROM auth.users WHERE lower(email) = lower(p_email) LIMIT 1
$$;
REVOKE EXECUTE ON FUNCTION public.admin_lookup_user_id_by_email(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_lookup_user_id_by_email(TEXT) TO service_role;

-- Used by admin-manage before disabling or demoting a super_admin: refuses
-- if the target is the last enabled super_admin, so the panel can never
-- lock every admin out of the Admins page at once.
CREATE FUNCTION public.count_active_super_admins() RETURNS INT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT count(*)::INT FROM public.admin_users WHERE role = 'super_admin' AND disabled_at IS NULL
$$;
REVOKE EXECUTE ON FUNCTION public.count_active_super_admins() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.count_active_super_admins() TO service_role;

-- Dashboard aggregate: user/signup/order counts. Deliberately separate
-- from collect_financial_integrity_metrics() (061_phase5_financial_monitoring.sql)
-- rather than folded into it — that RPC is polled by the automated
-- monitoring cron and alert-fingerprinting logic; this one is polled
-- on-demand by admins and covers a different axis (growth/volume, not
-- integrity/anomalies). The admin dashboard calls both.
CREATE FUNCTION public.collect_admin_dashboard_stats() RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'total_users', (SELECT count(*) FROM public.users),
    'new_users_24h', (SELECT count(*) FROM public.users WHERE created_at > now() - INTERVAL '24 hours'),
    'new_users_7d', (SELECT count(*) FROM public.users WHERE created_at > now() - INTERVAL '7 days'),
    'orders_24h', (SELECT count(*) FROM public.transactions WHERE created_at > now() - INTERVAL '24 hours'),
    'orders_completed_24h', (SELECT count(*) FROM public.transactions WHERE status = 'completed' AND created_at > now() - INTERVAL '24 hours')
  )
$$;
REVOKE EXECUTE ON FUNCTION public.collect_admin_dashboard_stats() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.collect_admin_dashboard_stats() TO service_role;
