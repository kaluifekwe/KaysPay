-- Migration 212 introduced the 'crypto_swap' transaction type but never
-- extended this CHECK constraint to allow it -- every record_crypto_swap_pending
-- insert has been failing the constraint since deploy, with no transaction
-- row ever created (confirmed live: a real swap attempt returned "Could not
-- start the swap" and left zero crypto_swap rows in the table). Same
-- allow-list-extension pattern every prior new transaction type has
-- followed (013, 018, 026, 033, 082, 117, 128).
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_type_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_type_check
  CHECK (type = ANY (ARRAY[
    'airtime'::text, 'data'::text, 'bill'::text, 'exam_pin'::text,
    'foreign_number'::text, 'card_fund'::text, 'payroll'::text,
    'wallet_fund'::text, 'refund'::text, 'withdrawal'::text, 'esim'::text,
    'nin_verification'::text, 'nin_validation'::text,
    'bvn_verification'::text, 'nin_name_modification'::text,
    'nin_phone_modification'::text, 'nin_address_modification'::text,
    'crypto_buy'::text, 'crypto_sell'::text, 'crypto_withdraw'::text,
    'crypto_deposit'::text, 'crypto_swap'::text, 'transfer'::text
  ]));
