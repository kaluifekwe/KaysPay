-- Kay's Pay: add 'nin_verification' and 'nin_validation' to allowed
-- transaction types (NIN Services feature)
-- =====================================================================
-- Same class of fix as migrations 013/018 — needed before nin-verify's and
-- nin-validate's debit_for_service calls can ever succeed.
-- =====================================================================

ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_type_check;

ALTER TABLE transactions ADD CONSTRAINT transactions_type_check
  CHECK (type = ANY (ARRAY[
    'airtime'::text, 'data'::text, 'bill'::text, 'exam_pin'::text,
    'foreign_number'::text, 'card_fund'::text, 'payroll'::text,
    'wallet_fund'::text, 'refund'::text, 'withdrawal'::text, 'esim'::text,
    'nin_verification'::text, 'nin_validation'::text
  ]));
