-- Only service providers for which KaysPay carries provider-side value belong
-- in this ledger. NOT VALID preserves any pre-existing audit rows while still
-- enforcing the approved scope for every new entry.
ALTER TABLE public.provider_finance_entries
  ADD CONSTRAINT provider_finance_entries_service_provider_check
  CHECK(provider IN ('vtunaija','airalo','quidax')) NOT VALID;

