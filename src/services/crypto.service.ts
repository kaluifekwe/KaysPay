import { supabase } from '../lib/supabase';
import { withTimeout, invokeWithRetry } from '../utils/network';

// Crypto buy/sell/withdraw — built ahead of Yellow Card's approval so the
// app-side pieces are ready to go live the moment their API access lands.
// Buy/sell are pure internal ledger swaps (see supabase/functions/crypto-
// buy and crypto-sell) and work today; withdrawal to an external wallet
// needs a real on-chain broadcast and returns a clear "not available yet"
// error until then — see supabase/functions/crypto-withdraw.
export type CryptoAsset = 'USDT';
export type CryptoNetwork = 'TRC20' | 'ERC20' | 'BEP20';

export const CRYPTO_NETWORKS: { key: CryptoNetwork; label: string }[] = [
  { key: 'TRC20', label: 'TRC-20 (Tron)' },
  { key: 'ERC20', label: 'ERC-20 (Ethereum)' },
  { key: 'BEP20', label: 'BEP-20 (BNB Smart Chain)' },
];

// Same rules enforced server-side in crypto-withdraw/index.ts — this copy is
// only for instant UI feedback (e.g. "this doesn't look right" the moment
// the user pastes), never trusted on its own for the actual send.
const ADDRESS_PATTERNS: Record<CryptoNetwork, RegExp> = {
  TRC20: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
  ERC20: /^0x[a-fA-F0-9]{40}$/,
  BEP20: /^0x[a-fA-F0-9]{40}$/,
};

export function isValidCryptoAddress(network: CryptoNetwork, address: string): boolean {
  return ADDRESS_PATTERNS[network].test(address.trim());
}

export interface SavedCryptoAddress {
  id: string;
  asset: CryptoAsset;
  network: CryptoNetwork;
  address: string;
  label: string | null;
  lastUsedAt: string;
}

export interface CryptoActionResult {
  success: boolean;
  error?: string;
  transactionId?: string;
}

function newIdempotencyKey(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export const cryptoService = {
  /** micro-USDT (6 decimals) -> a plain USDT amount for display/input. */
  microToAmount(micro: number): number {
    return micro / 1_000_000;
  },

  /** Live USD->NGN rate for display only — buy/sell always re-fetch it server-side. */
  async getQuoteRate(): Promise<number | null> {
    try {
      const { data, error } = await withTimeout(supabase.functions.invoke('crypto-quote', { body: {} }));
      if (error || !data?.success || !Number.isFinite(data.rate)) return null;
      return Number(data.rate);
    } catch {
      return null;
    }
  },

  async getBalance(asset: CryptoAsset = 'USDT'): Promise<number> {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return 0;
    const { data } = await withTimeout(
      (async () => await supabase.from('crypto_balances').select('balance_micro').eq('user_id', user.id).eq('asset', asset).maybeSingle())(),
    );
    return data ? cryptoService.microToAmount(Number(data.balance_micro)) : 0;
  },

  async buy(usdAmount: number, authToken: string): Promise<CryptoActionResult> {
    try {
      const idempotencyKey = newIdempotencyKey('crypto_buy');
      const { data, error } = await invokeWithRetry<any>(
        () => withTimeout(
          supabase.functions.invoke('crypto-buy', {
            body: { asset: 'USDT', usd_amount: usdAmount, auth_token: authToken, idempotency_key: idempotencyKey },
          }),
        ),
        idempotencyKey,
      );
      if (error) {
        let msg = 'Purchase failed. Please try again.';
        try {
          const errBody = await (error as any)?.context?.json?.();
          if (errBody?.error) msg = errBody.error;
        } catch {}
        return { success: false, error: msg };
      }
      if (!data?.success) return { success: false, error: data?.error || 'Purchase failed' };
      return { success: true, transactionId: data.transaction_id };
    } catch {
      return { success: false, error: 'Network error. Please try again.' };
    }
  },

  async sell(usdtAmount: number, authToken: string): Promise<CryptoActionResult> {
    try {
      const idempotencyKey = newIdempotencyKey('crypto_sell');
      const { data, error } = await invokeWithRetry<any>(
        () => withTimeout(
          supabase.functions.invoke('crypto-sell', {
            body: { asset: 'USDT', crypto_amount: usdtAmount, auth_token: authToken, idempotency_key: idempotencyKey },
          }),
        ),
        idempotencyKey,
      );
      if (error) {
        let msg = 'Sale failed. Please try again.';
        try {
          const errBody = await (error as any)?.context?.json?.();
          if (errBody?.error) msg = errBody.error;
        } catch {}
        return { success: false, error: msg };
      }
      if (!data?.success) return { success: false, error: data?.error || 'Sale failed' };
      return { success: true, transactionId: data.transaction_id };
    } catch {
      return { success: false, error: 'Network error. Please try again.' };
    }
  },

  async withdraw(
    network: CryptoNetwork,
    address: string,
    usdtAmount: number,
    authToken: string,
  ): Promise<CryptoActionResult> {
    try {
      const idempotencyKey = newIdempotencyKey('crypto_wd');
      const { data, error } = await withTimeout(
        supabase.functions.invoke('crypto-withdraw', {
          body: {
            asset: 'USDT',
            network,
            address: address.trim(),
            crypto_amount: usdtAmount,
            auth_token: authToken,
            idempotency_key: idempotencyKey,
          },
        }),
      );
      if (error) {
        let msg = 'Withdrawal failed. Please try again.';
        try {
          const errBody = await (error as any)?.context?.json?.();
          if (errBody?.error) msg = errBody.error;
        } catch {}
        return { success: false, error: msg };
      }
      if (!data?.success) return { success: false, error: data?.error || 'Withdrawal failed' };
      return { success: true, transactionId: data.transaction_id };
    } catch {
      return { success: false, error: 'Network error. Please try again.' };
    }
  },

  async listSavedAddresses(asset: CryptoAsset = 'USDT'): Promise<SavedCryptoAddress[]> {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return [];
    const { data, error } = await withTimeout(
      (async () => await supabase.from('crypto_saved_addresses')
        .select('id, asset, network, address, label, last_used_at')
        .eq('user_id', user.id)
        .eq('asset', asset)
        .order('last_used_at', { ascending: false }))(),
    );
    if (error || !data) return [];
    return data.map((r: any) => ({
      id: r.id,
      asset: r.asset,
      network: r.network,
      address: r.address,
      label: r.label,
      lastUsedAt: r.last_used_at,
    }));
  },

  async saveAddress(network: CryptoNetwork, address: string, label: string): Promise<void> {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    await withTimeout(
      (async () => await supabase.from('crypto_saved_addresses').upsert(
        {
          user_id: user.id,
          asset: 'USDT',
          network,
          address: address.trim(),
          label: label.trim() || null,
          last_used_at: new Date().toISOString(),
        },
        { onConflict: 'user_id,asset,network,address' },
      ))(),
    );
  },

  async touchAddress(id: string): Promise<void> {
    await withTimeout(
      (async () => await supabase.from('crypto_saved_addresses').update({ last_used_at: new Date().toISOString() }).eq('id', id))(),
    );
  },
};
