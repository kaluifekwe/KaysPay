-- Kay's Pay: drop the temporary webhook debug log
-- =====================================================================
-- Migration 024's diagnostic table served its purpose — confirmed the
-- Flutterwave webhook signature scheme (HMAC-SHA256, base64) and that
-- amounts are reported in naira, not kobo. No longer needed.
-- =====================================================================

DROP TABLE IF EXISTS webhook_debug_log;
