-- Kay's Pay: Airalo Partner API OAuth2 token cache
-- =====================================================================
-- Airalo's /v2/token endpoint is rate-limited to 3 requests/minute and
-- issues a token valid for ~24h. Cache one shared token here instead of
-- fetching a fresh one per request, refreshed only when it's actually near
-- expiry. Server-only: no client ever needs to read this.
-- =====================================================================

CREATE TABLE IF NOT EXISTS airalo_auth (
  id         INT PRIMARY KEY DEFAULT 1 CHECK (id = 1), -- single row
  token      TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

ALTER TABLE airalo_auth ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON airalo_auth FROM anon, authenticated;
