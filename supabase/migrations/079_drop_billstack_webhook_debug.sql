-- Kay's Pay: drop the temporary BillStack signature-debug table
-- =====================================================================
-- Migration 078's diagnostic table did its job — root cause found (trailing
-- whitespace in the stored secret) and fixed. No longer needed.
-- =====================================================================

DROP TABLE IF EXISTS billstack_webhook_debug;
