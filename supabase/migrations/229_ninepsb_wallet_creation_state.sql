-- Supports 9PSB's two-round-trip wallet-creation flow (identity/initiate +
-- OTP verify, then open_wallet) by tracking whether a virtual_accounts row
-- is fully provisioned yet. Existing Flutterwave/Paystack rows default to
-- 'active' and are unaffected -- they were always created atomically in one
-- call, unlike 9PSB's flow.

ALTER TABLE public.virtual_accounts ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('active', 'pending_identity'));
