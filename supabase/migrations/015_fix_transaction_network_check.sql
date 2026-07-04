-- Kay's Pay: fix transactions.network case mismatch
-- =====================================================================
-- transactions_network_check required Title-Case values ('MTN', 'Airtel',
-- 'Glo', '9mobile'), but the entire codebase — client NetworkProvider type,
-- server vtu-catalog.ts, and the VTU.ng API's own service_id values — uses
-- lowercase ('mtn', 'airtel', 'glo', '9mobile'). Every airtime/data purchase
-- has therefore always failed at this exact INSERT inside debit_for_service
-- (same class of bug as 013's transactions_type_check fix — never caught
-- because no purchase had gone through this code path with real credentials
-- until now). No existing rows use the old values, so this is a clean swap.
-- =====================================================================

ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_network_check;

ALTER TABLE transactions ADD CONSTRAINT transactions_network_check
  CHECK (network = ANY (ARRAY['mtn'::text, 'airtel'::text, 'glo'::text, '9mobile'::text, 'N/A'::text]));
