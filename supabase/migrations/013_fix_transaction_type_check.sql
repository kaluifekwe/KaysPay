-- Kay's Pay: fix missing 'withdrawal' transaction type
-- =====================================================================
-- transactions_type_check never included 'withdrawal', even though
-- debit_for_withdrawal() has always inserted type = 'withdrawal' and the
-- TypeScript TransactionType union has always included it. Every
-- withdrawal attempt has therefore always failed at the INSERT INTO
-- transactions step inside debit_for_withdrawal (which rolls back the
-- whole function, including the wallet debit — no money was ever lost,
-- withdrawals just silently could never start).
-- =====================================================================

ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_type_check;

ALTER TABLE transactions ADD CONSTRAINT transactions_type_check
  CHECK (type = ANY (ARRAY[
    'airtime'::text, 'data'::text, 'bill'::text, 'exam_pin'::text,
    'foreign_number'::text, 'card_fund'::text, 'payroll'::text,
    'wallet_fund'::text, 'refund'::text, 'withdrawal'::text
  ]));
