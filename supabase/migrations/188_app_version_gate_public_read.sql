-- app_version_gate needs no edge function at all -- it's a plain config
-- read (version numbers, a message, a public store URL), nothing sensitive
-- and nothing computed. Read directly via Supabase's own auto-generated
-- REST API instead, which costs no edge-function slot (the project is at
-- its 100/100 function cap). Admin writes still go through
-- admin-app-version-gate, which needs the real requireAdmin/audit-log logic
-- a plain table grant can't provide -- this migration only ever widens SELECT.
GRANT SELECT (platform, min_build_number, min_version, required, message, store_url)
  ON public.app_version_gate TO anon, authenticated;

CREATE POLICY app_version_gate_public_read ON public.app_version_gate
  FOR SELECT TO anon, authenticated USING (true);
