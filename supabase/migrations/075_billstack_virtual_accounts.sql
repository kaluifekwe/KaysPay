-- Kay's Pay: add BillStack as a second dedicated-virtual-account provider
-- alongside Flutterwave (migration 023). A user may now hold one account
-- PER PROVIDER (not one account total) — whichever gets funded credits the
-- same wallet via the existing credit_wallet_funding RPC (already
-- provider-agnostic via its free-text p_source param, no RPC change needed).
-- =====================================================================

-- Existing rows (Flutterwave-only, implicit) get the default explicitly so
-- the NOT NULL + CHECK below never sees a null during backfill.
ALTER TABLE virtual_accounts ADD COLUMN IF NOT EXISTS provider TEXT;
UPDATE virtual_accounts SET provider = 'flutterwave' WHERE provider IS NULL;
ALTER TABLE virtual_accounts ALTER COLUMN provider SET DEFAULT 'flutterwave';
ALTER TABLE virtual_accounts ALTER COLUMN provider SET NOT NULL;
ALTER TABLE virtual_accounts ADD CONSTRAINT virtual_accounts_provider_check
  CHECK (provider IN ('flutterwave', 'billstack'));

-- Replace the user_id-only PK with a composite (user_id, provider) PK — this
-- directly encodes "at most one account per user per provider" without a
-- surrogate key. Nothing else in the schema references virtual_accounts as
-- an FK target, so this is an isolated, safe change.
ALTER TABLE virtual_accounts DROP CONSTRAINT virtual_accounts_pkey;
ALTER TABLE virtual_accounts ADD PRIMARY KEY (user_id, provider);

-- customer_code's UNIQUE partial index (migration 035) is left untouched —
-- deliberately GLOBAL across providers, not scoped per-provider. Flutterwave's
-- "cus_..." ids and BillStack's customer ids will never collide in practice,
-- and global uniqueness preserves the existing "misrouted deposit" guarantee
-- both webhooks rely on when resolving user_id from customer_code.

-- RLS/grants are unchanged: owners still SELECT only their own rows (now up
-- to 2 instead of at most 1), only service_role writes.
