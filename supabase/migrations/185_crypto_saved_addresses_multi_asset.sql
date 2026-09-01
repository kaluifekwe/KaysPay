-- Widens crypto_saved_addresses for Withdraw's first non-USDT asset (BTC,
-- see supabase/functions/_shared/crypto-withdraw-assets.ts). Both CHECK
-- constraints previously hardcoded 'USDT'/TRC20|ERC20|BEP20 only.
--
-- BTC has no network to choose (single native chain), so the client passes
-- the asset code itself as "network" for these -- keeps the column
-- meaningfully NOT NULL and the existing (user_id, asset, network, address)
-- uniqueness shape intact, rather than relaxing it to nullable.
ALTER TABLE public.crypto_saved_addresses DROP CONSTRAINT crypto_saved_addresses_asset_check;
ALTER TABLE public.crypto_saved_addresses ADD CONSTRAINT crypto_saved_addresses_asset_check
  CHECK (asset IN ('USDT', 'BTC'));

ALTER TABLE public.crypto_saved_addresses DROP CONSTRAINT crypto_saved_addresses_network_check;
ALTER TABLE public.crypto_saved_addresses ADD CONSTRAINT crypto_saved_addresses_network_check
  CHECK (network IN ('TRC20', 'ERC20', 'BEP20', 'BTC'));
