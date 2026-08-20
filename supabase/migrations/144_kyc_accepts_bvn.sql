-- 144_kyc_accepts_bvn.sql
--
-- The free, self-serve KYC check (kyc-verify-nin) now accepts BVN as an
-- alternative to NIN — same free, no-wallet-debit model, just whichever
-- national identifier the user actually has on hand. Adds the column to
-- store it; the existing `nin` column stays for the NIN path.

ALTER TABLE user_kyc ADD COLUMN IF NOT EXISTS bvn TEXT;
