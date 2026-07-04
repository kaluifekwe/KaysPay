-- Kay's Pay: VTU.ng API v2 JWT token cache
-- =====================================================================
-- v2 auth issues a JWT that's valid for 7 days, but "only the latest token
-- remains active — generating a new token invalidates older ones." With
-- concurrent requests, fetching a fresh token per-request would invalidate
-- tokens other in-flight requests are using. Cache one shared token here
-- instead, refreshed only when it's actually near expiry (or on a 403 retry).
-- Server-only: no client ever needs to read this.
-- =====================================================================

CREATE TABLE IF NOT EXISTS vtu_ng_auth (
  id         INT PRIMARY KEY DEFAULT 1 CHECK (id = 1), -- single row
  token      TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

ALTER TABLE vtu_ng_auth ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON vtu_ng_auth FROM anon, authenticated;
