-- Kay's Pay: Paystack Integration Tables
-- Run this in Supabase SQL Editor

-- Add bank details to users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS bank_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS bank_code TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS account_number TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS account_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS paystack_customer_id TEXT;

-- Add 'withdrawal' to transaction type check
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_type_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_type_check
  CHECK (type IN ('airtime','data','bill','exam_pin','foreign_number','card_fund','payroll','wallet_fund','refund','withdrawal'));

-- Withdrawals table
CREATE TABLE IF NOT EXISTS withdrawals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) NOT NULL,
  amount_ngn NUMERIC(12,2) NOT NULL,
  bank_name TEXT NOT NULL,
  bank_code TEXT NOT NULL,
  account_number TEXT NOT NULL,
  account_name TEXT NOT NULL,
  status TEXT CHECK (status IN ('pending','processing','completed','failed')) DEFAULT 'pending',
  paystack_transfer_code TEXT,
  paystack_reference TEXT,
  failure_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ
);

ALTER TABLE withdrawals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own withdrawals" ON withdrawals;
CREATE POLICY "Users can view own withdrawals" ON withdrawals
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own withdrawals" ON withdrawals;
CREATE POLICY "Users can insert own withdrawals" ON withdrawals
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own withdrawals" ON withdrawals;
CREATE POLICY "Users can update own withdrawals" ON withdrawals
  FOR UPDATE USING (auth.uid() = user_id);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_withdrawals_user_id ON withdrawals(user_id);
CREATE INDEX IF NOT EXISTS idx_withdrawals_status ON withdrawals(status);
