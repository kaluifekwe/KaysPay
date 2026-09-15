-- Single-row cache for 9PSB's WAAS bearer token, mirroring the existing
-- Flutterwave auth-cache pattern. 9PSB's expiresIn is dynamic (returned per
-- authenticate call), so the client computes expires_at itself with a safety
-- margin rather than trusting a hardcoded constant.

CREATE TABLE IF NOT EXISTS public.nine_psb_auth (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.nine_psb_auth ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.nine_psb_auth FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.nine_psb_auth TO service_role;
