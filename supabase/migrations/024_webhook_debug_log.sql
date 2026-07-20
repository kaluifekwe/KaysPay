-- Kay's Pay: temporary webhook debug log
-- =====================================================================
-- One-off diagnostic table to inspect exactly what Flutterwave's webhook
-- sends (headers + raw body) before committing to a signature-verification
-- scheme — their own docs contradict themselves on it. Server-only, no
-- client access. Drop this once the real scheme is confirmed.
-- =====================================================================

CREATE TABLE IF NOT EXISTS webhook_debug_log (
  id         BIGSERIAL PRIMARY KEY,
  source     TEXT NOT NULL,
  headers    JSONB,
  body       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE webhook_debug_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON webhook_debug_log FROM anon, authenticated;
