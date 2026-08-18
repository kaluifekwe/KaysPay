-- Owner-editable app settings (2026-08-18). Replaces the support WhatsApp
-- number being hardcoded in three separate places in the mobile app
-- (TabNavigator, MoreScreen, ProfileScreen) — changing it used to mean a
-- code change plus an OTA ship. Now it's a row the owner edits from the
-- admin Settings page and the app picks up on its next launch.
--
-- Keys are CHECK-constrained rather than free-form, matching how
-- service_pricing and service_controls do it: a typo'd key fails loudly
-- instead of silently creating a junk row the app will never read. Adding a
-- new setting is a one-line migration to extend the list.
CREATE TABLE public.app_settings (
  key        TEXT PRIMARY KEY CHECK (key IN ('support_whatsapp_number')),
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The new support number (owner-provided 2026-08-18), stored in the digits-
-- only international form wa.me expects (no +, no spaces).
INSERT INTO public.app_settings(key, value)
VALUES ('support_whatsapp_number', '2349068446111')
ON CONFLICT (key) DO NOTHING;

-- Read-only to logged-in users, writes are service-role only (the
-- admin-app-settings edge function). A support phone number is not
-- sensitive, but there's no reason to expose it to anon either — every
-- place the app shows it is behind login. Same shape as migration 092's
-- vtu_availability_revisions.
ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.app_settings FROM PUBLIC, anon;
GRANT SELECT ON public.app_settings TO authenticated;

CREATE POLICY "Authenticated users can read app settings"
  ON public.app_settings FOR SELECT TO authenticated
  USING (true);
