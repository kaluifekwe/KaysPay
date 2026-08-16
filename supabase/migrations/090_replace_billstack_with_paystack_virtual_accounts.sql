-- Replace BillStack with Paystack as the second virtual-account provider.
-- Historical migrations remain immutable; this migration removes BillStack's
-- live data/schema allowance without changing wallet balances or transactions.

DELETE FROM virtual_accounts WHERE provider = 'billstack';

ALTER TABLE virtual_accounts DROP CONSTRAINT IF EXISTS virtual_accounts_provider_check;
ALTER TABLE virtual_accounts ADD CONSTRAINT virtual_accounts_provider_check
  CHECK (provider IN ('flutterwave', 'paystack'));

-- The Paystack webhook resolves the owner from the receiving DVA number.
CREATE UNIQUE INDEX IF NOT EXISTS idx_virtual_accounts_account_number_unique
  ON virtual_accounts (account_number)
  WHERE account_number IS NOT NULL;

