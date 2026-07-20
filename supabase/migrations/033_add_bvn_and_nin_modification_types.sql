-- Kay's Pay: add 'bvn_verification' and the three NIN modification order
-- types to allowed transaction types (BVN Verification + NIN Update
-- Name/Phone/Address features)
-- =====================================================================
-- Same class of fix as migrations 013/018/026 — needed before bvn-verify's
-- and nin-modify's debit_for_service calls can ever succeed.
-- =====================================================================

ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_type_check;

ALTER TABLE transactions ADD CONSTRAINT transactions_type_check
  CHECK (type = ANY (ARRAY[
    'airtime'::text, 'data'::text, 'bill'::text, 'exam_pin'::text,
    'foreign_number'::text, 'card_fund'::text, 'payroll'::text,
    'wallet_fund'::text, 'refund'::text, 'withdrawal'::text, 'esim'::text,
    'nin_verification'::text, 'nin_validation'::text,
    'bvn_verification'::text, 'nin_name_modification'::text,
    'nin_phone_modification'::text, 'nin_address_modification'::text
  ]));
