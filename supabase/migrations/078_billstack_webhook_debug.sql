-- Kay's Pay: temporary diagnostic table for the BillStack signature mismatch
-- =====================================================================
-- Real webhook deliveries (confirmed via BillStack's own Webhook Events log,
-- 2026-08-04) are correctly shaped but consistently fail our signature
-- check. Rather than keep relying on the owner relaying dashboard
-- screenshots, this captures both sides of the comparison so it can be
-- queried directly via SQL. Server-only (never exposed via PostgREST to
-- anon/authenticated) — same posture as every other internal table in this
-- codebase, and same pattern already used once before in this project to
-- capture a real BillStack webhook payload. DROP this table once the real
-- mismatch is found and fixed; it's diagnostic-only, not permanent state.
-- =====================================================================

CREATE TABLE IF NOT EXISTS billstack_webhook_debug (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  received_signature  TEXT,
  candidates          JSONB,
  matched             BOOLEAN NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE billstack_webhook_debug ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON billstack_webhook_debug FROM anon, authenticated;
