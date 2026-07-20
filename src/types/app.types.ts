export interface User {
  id: string;
  phone: string;
  full_name: string | null;
  avatar_url: string | null;
  pin_hash: string;
  biometric_enabled: boolean;
  created_at: string;
  last_active: string | null;
}

export interface Wallet {
  id: string;
  user_id: string;
  balance: number;
  locked_amount: number;
  available_balance: number;
  updated_at: string;
}

export type TransactionType =
  | 'airtime'
  | 'data'
  | 'bill'
  | 'exam_pin'
  | 'foreign_number'
  | 'card_fund'
  | 'payroll'
  | 'wallet_fund'
  | 'refund'
  | 'withdrawal'
  | 'nin_verification'
  | 'nin_validation';

export type TransactionStatus = 'pending' | 'completed' | 'failed' | 'refunded';

export interface Transaction {
  id: string;
  user_id: string;
  type: TransactionType;
  recipient_phone: string | null;
  network: string | null;
  amount_ngn: number;
  amount_usd: number | null;
  status: TransactionStatus;
  vtu_order_id: string | null;
  metadata: Record<string, any> | null;
  created_at: string;
  completed_at: string | null;
}

export type PayrollServiceType = 'airtime' | 'data';

export type PayrollScheduleType = 'once' | 'weekly' | 'monthly' | 'custom';

export type PayrollFailurePreference = 'partial' | 'cancel' | 'top_up';

export type PayrollStatus = 'active' | 'paused' | 'completed' | 'cancelled';

export interface PayrollPlan {
  id: string;
  user_id: string;
  name: string;
  service_type: PayrollServiceType;
  data_bundle_code: string | null;
  schedule_type: PayrollScheduleType;
  scheduled_at: string;
  repeat_day: number | null;
  failure_preference: PayrollFailurePreference;
  status: PayrollStatus;
  locked_amount: number;
  created_at: string;
}

export interface PayrollRecipient {
  id: string;
  plan_id: string;
  phone_number: string;
  amount_ngn: number;
  last_status: string;
  last_delivered_at: string | null;
}

export type VirtualCardStatus = 'active' | 'frozen' | 'cancelled';

export interface VirtualCard {
  id: string;
  user_id: string;
  card_provider_id: string | null;
  last_four: string;
  expiry_month: number;
  expiry_year: number;
  balance_usd: number;
  is_frozen: boolean;
  status: VirtualCardStatus;
  created_at: string;
}

export interface Contact {
  name: string;
  numbers: {
    number: string;
    network: string;
    color: string;
  }[];
}

export interface QuickAction {
  id: string;
  icon: string;
  label: string;
  screen: string;
}

export interface Notification {
  id: string;
  user_id: string;
  title: string;
  body: string;
  type: string;
  read: boolean;
  created_at: string;
}

export type WithdrawalStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface Withdrawal {
  id: string;
  user_id: string;
  amount_ngn: number;
  bank_name: string;
  bank_code: string;
  account_number: string;
  account_name: string;
  status: WithdrawalStatus;
  paystack_transfer_code: string | null;
  paystack_reference: string | null;
  failure_reason: string | null;
  created_at: string;
  completed_at: string | null;
}
