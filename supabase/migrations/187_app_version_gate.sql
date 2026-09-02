-- Two-mode app update gate (owner decision, 2026-09-02): the client compares
-- its own installed build number against this server-controlled minimum.
-- `required=false` -> a dismissible "Update available" nudge; `required=true`
-- -> the full-screen blocking gate. Same threshold, one flag decides which,
-- so escalating a specific release needs no new app build -- just this row.
--
-- Seeded at min_build_number=1 / required=false so nothing shows for anyone
-- until the owner deliberately raises it via the admin dashboard.
CREATE TABLE public.app_version_gate (
  platform TEXT PRIMARY KEY CHECK (platform IN ('android', 'ios')),
  min_build_number INT NOT NULL CHECK (min_build_number > 0),
  min_version TEXT NOT NULL,
  required BOOLEAN NOT NULL DEFAULT FALSE,
  message TEXT,
  store_url TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.app_version_gate ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.app_version_gate FROM PUBLIC, anon, authenticated;
GRANT SELECT, UPDATE ON public.app_version_gate TO service_role;

-- Android only for now -- no iOS store listing exists yet anywhere in this
-- codebase to link to; add an ios row (and the client-side check for it)
-- once that's real.
INSERT INTO public.app_version_gate (platform, min_build_number, min_version, required, message, store_url) VALUES
  ('android', 1, '1.0.1', FALSE,
   'A new version of KaysPay is available.',
   'https://play.google.com/store/apps/details?id=com.kayspay.app');
