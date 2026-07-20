-- Kay's Pay: index the NIN/BVN verification cache lookup; make
-- virtual_accounts.customer_code actually unique
-- =====================================================================
-- 1. nin-verify and bvn-verify both cache-check with:
--      user_id = ? AND type = ? AND status = 'completed'
--      AND recipient_phone = ? ORDER BY created_at DESC LIMIT 1
--    Only user_id/status were indexed (migration 005), so this scan gets
--    slower as `transactions` grows — worse, it's on the hot path for a
--    paid, provider-billed lookup deciding "serve from cache or call the
--    provider again". One partial index covers both nin_verification and
--    bvn_verification (type is a real column, not baked into the WHERE).
--
-- 2. virtual_accounts.customer_code only had a plain (non-unique) index
--    (migration 011), even though both bank-transfer webhooks trust it via
--    .maybeSingle() to decide which user's wallet to credit on an incoming
--    transfer. Not currently exploitable (the write path upserts on the
--    user_id primary key), but nothing at the DB level would stop a future
--    duplicate customer_code from misrouting a deposit. Making it UNIQUE
--    turns that into a hard guarantee instead of an assumption.
-- =====================================================================

CREATE INDEX IF NOT EXISTS idx_transactions_verify_cache
  ON transactions (user_id, type, recipient_phone, created_at DESC)
  WHERE status = 'completed';

DROP INDEX IF EXISTS idx_virtual_accounts_customer_code;
CREATE UNIQUE INDEX IF NOT EXISTS idx_virtual_accounts_customer_code_unique
  ON virtual_accounts (customer_code)
  WHERE customer_code IS NOT NULL;
