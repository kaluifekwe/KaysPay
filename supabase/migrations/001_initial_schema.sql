-- Kay's Pay Database Schema
-- Run this in Supabase SQL Editor

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone TEXT UNIQUE NOT NULL,
  full_name TEXT,
  avatar_url TEXT,
  pin_hash TEXT NOT NULL,
  biometric_enabled BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  last_active TIMESTAMPTZ
);

-- Enable RLS on users
ALTER TABLE users ENABLE ROW LEVEL SECURITY;

-- Users policies
CREATE POLICY "Users can view own profile" ON users
  FOR SELECT USING (auth.uid() = id);

CREATE POLICY "Users can update own profile" ON users
  FOR UPDATE USING (auth.uid() = id);

-- Wallets table
CREATE TABLE IF NOT EXISTS wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) UNIQUE NOT NULL,
  balance NUMERIC(15,2) DEFAULT 0.00,
  locked_amount NUMERIC(15,2) DEFAULT 0.00,
  available_balance NUMERIC(15,2) GENERATED ALWAYS AS (balance - locked_amount) STORED,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Enable RLS on wallets
ALTER TABLE wallets ENABLE ROW LEVEL SECURITY;

-- Wallets policies
CREATE POLICY "Users can view own wallet" ON wallets
  FOR SELECT USING (auth.uid() = user_id);

-- Transactions table
CREATE TABLE IF NOT EXISTS transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) NOT NULL,
  type TEXT CHECK (type IN ('airtime','data','bill','exam_pin','foreign_number','card_fund','payroll','wallet_fund','refund')) NOT NULL,
  recipient_phone TEXT,
  network TEXT CHECK (network IN ('MTN','Airtel','Glo','9mobile','N/A')),
  amount_ngn NUMERIC(15,2) NOT NULL,
  amount_usd NUMERIC(15,4),
  status TEXT CHECK (status IN ('pending','completed','failed','refunded')) NOT NULL,
  vtu_order_id TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ
);

-- Enable RLS on transactions
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;

-- Transactions policies
CREATE POLICY "Users can view own transactions" ON transactions
  FOR SELECT USING (auth.uid() = user_id);

-- Function to create wallet on user creation
CREATE OR REPLACE FUNCTION create_user_wallet()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO wallets (user_id, balance)
  VALUES (NEW.id, 0.00);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger to create wallet when user is created
CREATE OR REPLACE TRIGGER on_user_created
  AFTER INSERT ON users
  FOR EACH ROW
  EXECUTE FUNCTION create_user_wallet();
