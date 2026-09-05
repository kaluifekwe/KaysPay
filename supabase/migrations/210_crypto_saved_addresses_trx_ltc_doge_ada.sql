-- Widens crypto_saved_addresses for Withdraw's TRX/LTC/DOGE/ADA rollout (see
-- supabase/functions/_shared/crypto-withdraw-assets.ts), same shape as
-- migrations 185/189 did for BTC/ETH/SOL: all four are single-network
-- assets, so the client passes the asset code itself as "network" -- keeps
-- the column NOT NULL and the existing (user_id, asset, network, address)
-- uniqueness intact. XRP is deliberately not included here -- see the
-- owner-decision comment in crypto-withdraw-assets.ts on why it needs its
-- own destination-tag work before Withdraw supports it.
ALTER TABLE public.crypto_saved_addresses DROP CONSTRAINT crypto_saved_addresses_asset_check;
ALTER TABLE public.crypto_saved_addresses ADD CONSTRAINT crypto_saved_addresses_asset_check
  CHECK (asset IN ('USDT', 'BTC', 'ETH', 'SOL', 'TRX', 'LTC', 'DOGE', 'ADA'));

ALTER TABLE public.crypto_saved_addresses DROP CONSTRAINT crypto_saved_addresses_network_check;
ALTER TABLE public.crypto_saved_addresses ADD CONSTRAINT crypto_saved_addresses_network_check
  CHECK (network IN ('TRC20', 'ERC20', 'BEP20', 'BTC', 'ETH', 'SOL', 'TRX', 'LTC', 'DOGE', 'ADA'));
