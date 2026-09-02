-- Widens crypto_saved_addresses for Withdraw's ETH and SOL rollout (see
-- supabase/functions/_shared/crypto-withdraw-assets.ts), same shape as
-- migration 185 did for BTC: both are single-network assets, so the client
-- passes the asset code itself as "network" -- keeps the column NOT NULL
-- and the existing (user_id, asset, network, address) uniqueness intact.
ALTER TABLE public.crypto_saved_addresses DROP CONSTRAINT crypto_saved_addresses_asset_check;
ALTER TABLE public.crypto_saved_addresses ADD CONSTRAINT crypto_saved_addresses_asset_check
  CHECK (asset IN ('USDT', 'BTC', 'ETH', 'SOL'));

ALTER TABLE public.crypto_saved_addresses DROP CONSTRAINT crypto_saved_addresses_network_check;
ALTER TABLE public.crypto_saved_addresses ADD CONSTRAINT crypto_saved_addresses_network_check
  CHECK (network IN ('TRC20', 'ERC20', 'BEP20', 'BTC', 'ETH', 'SOL'));
