-- Fast, unique callback lookup without exposing customer data. New VTUAfrica
-- transactions persist this provider-normalized reference before dispatch.
CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_provider_reference
  ON public.transactions ((metadata->>'provider_reference'))
  WHERE metadata ? 'provider_reference';
