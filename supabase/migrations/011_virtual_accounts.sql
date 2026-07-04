-- Kay's Pay: Dedicated Virtual Accounts (fund by bank transfer)
-- =====================================================================
-- Each user gets a permanent NUBAN (via Paystack DVA). Transfers to it
-- credit the wallet automatically through the existing webhook +
-- credit_wallet_funding RPC. This table maps Paystack customer/account to
-- the user and lets the webhook resolve which user a transfer belongs to.
-- =====================================================================

CREATE TABLE IF NOT EXISTS virtual_accounts (
  user_id        UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  customer_code  TEXT,
  customer_id    TEXT,
  account_number TEXT,
  bank_name      TEXT,
  account_name   TEXT,
  dva_id         TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE virtual_accounts ENABLE ROW LEVEL SECURITY;

-- Owner may read their own account details (the number is theirs to see).
DROP POLICY IF EXISTS "Users can view own virtual account" ON virtual_accounts;
CREATE POLICY "Users can view own virtual account" ON virtual_accounts
  FOR SELECT USING (auth.uid() = user_id);

-- Only the Edge Function (service role) writes here.
REVOKE INSERT, UPDATE, DELETE ON virtual_accounts FROM anon, authenticated;

-- The webhook resolves DVA transfers by Paystack customer_code.
CREATE INDEX IF NOT EXISTS idx_virtual_accounts_customer_code
  ON virtual_accounts (customer_code);
