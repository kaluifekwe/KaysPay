-- Kay's Pay: add 'esim' to allowed transaction types (Travel eSIM feature)
-- =====================================================================
-- Same class of fix as migration 013 ('withdrawal') and needed before
-- esim-purchase's debit_for_service call can ever succeed.
-- =====================================================================

ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_type_check;

ALTER TABLE transactions ADD CONSTRAINT transactions_type_check
  CHECK (type = ANY (ARRAY[
    'airtime'::text, 'data'::text, 'bill'::text, 'exam_pin'::text,
    'foreign_number'::text, 'card_fund'::text, 'payroll'::text,
    'wallet_fund'::text, 'refund'::text, 'withdrawal'::text, 'esim'::text
  ]));
