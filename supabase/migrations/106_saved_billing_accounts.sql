-- User-owned, provider-verified TV smartcards and electricity meters.
-- Writes are server-only so a client cannot label an unverified number as trusted.

CREATE TABLE public.saved_billing_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  service TEXT NOT NULL CHECK (service IN ('tv', 'electricity')),
  provider_id TEXT NOT NULL CHECK (provider_id ~ '^[a-z0-9-]{2,50}$'),
  account_number TEXT NOT NULL CHECK (account_number ~ '^[0-9]{6,20}$'),
  customer_name TEXT NOT NULL CHECK (char_length(customer_name) BETWEEN 1 AND 200),
  provider_customer_name TEXT NOT NULL CHECK (char_length(provider_customer_name) BETWEEN 1 AND 200),
  customer_address TEXT,
  last_verified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, service, provider_id, account_number)
);

CREATE INDEX saved_billing_accounts_recent_idx
  ON public.saved_billing_accounts (user_id, service, provider_id, last_used_at DESC);

ALTER TABLE public.saved_billing_accounts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.saved_billing_accounts FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.saved_billing_accounts TO service_role;
