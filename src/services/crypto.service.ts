import { supabase } from '../lib/supabase';
import { withTimeout, invokeWithRetry } from '../utils/network';

// Crypto buy/sell/withdraw, all against the customer's own Quidax
// sub-account — KaysPay never fronts liquidity. Buy pays Quidax's Ramp
// product via bank transfer (supabase/functions/crypto-buy); Sell and
// Withdraw spend the sub-account balance directly through Quidax's
// exchange API (crypto-sell, crypto-withdraw).
export type CryptoAsset = 'USDT';
export type CryptoNetwork = 'TRC20' | 'ERC20' | 'BEP20';

// Coins Buy supports beyond USDT — kept in sync with the curated list in
// supabase/functions/_shared/crypto-assets.ts. Each goes through a two-leg
// purchase (NGN -> USDT -> swap, see crypto-buy/crypto-quidax-webhook) and
// lands in the KaysPay crypto account only — no external-wallet delivery
// for these yet, only USDT keeps that option.
export type SwapAssetCode = 'BTC' | 'ETH' | 'SOL' | 'XRP' | 'TRX' | 'LTC' | 'DOGE' | 'ADA';
export type BuyAsset = 'USDT' | SwapAssetCode;

export interface MarketCoin {
  code: BuyAsset;
  name: string;
  stablecoin: boolean;
  priceNgn: number;
  change24hPct: number | null;
  // Real reference points from today's order book (not a tick history —
  // Quidax's ticker doesn't offer one) used to shape the coin list's
  // sparkline honestly rather than with fabricated data.
  openNgn: number | null;
  lowNgn: number | null;
  highNgn: number | null;
}

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
  // Sell and withdraw settle asynchronously on Quidax's side — the request
  // succeeding only means it was accepted, not that it has completed.
  pending?: boolean;
  message?: string;
}

function newIdempotencyKey(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export interface QuidaxWalletBalance {
  currency: string;
  balance: number;
  locked: number;
  isCrypto: boolean;
}

export interface CryptoBuyPayment {
  accountName: string;
  accountNumber: string;
  bankName: string;
  /** Total to transfer, including processor fee and VAT. */
  amountToPay: number;
  amount: number;
  processorFee: number;
  vat: number;
  /** Kay's Pay markup itemised by Quidax; already included in amountToPay. */
  merchantMarkup: number;
}

export interface CryptoBuyResult {
  success: boolean;
  error?: string;
  transactionId?: string;
  asset?: BuyAsset;
  estimatedCrypto?: number;
  // True when this purchase still needs a second leg (USDT -> the target
  // coin) after the bank transfer clears — every asset except USDT.
  pendingSwap?: boolean;
  destinationType?: 'kayspay_account' | 'external_wallet';
  destinationAddress?: string;
  payment?: CryptoBuyPayment;
}

export const cryptoService = {
  /** micro-USDT (6 decimals) -> a plain USDT amount for display/input. */
  microToAmount(micro: number): number {
    return micro / 1_000_000;
  },

  /**
   * Live USDT/NGN market price from Quidax, for display only — buy and sell
   * always re-derive their own price server-side. `buyRate` is the ask (what
   * buying costs) and `sellRate` the bid (what selling earns), so each side
   * of the screen can show the price it would really get instead of a single
   * mid-market number that flatters both.
   */
  async getQuoteRate(): Promise<{ rate: number; buyRate: number; sellRate: number } | null> {
    try {
      const { data, error } = await withTimeout(supabase.functions.invoke('crypto-quote', { body: {} }));
      if (error || !data?.success || !Number.isFinite(data.rate)) return null;
      const rate = Number(data.rate);
      const buyRate = Number(data.buy_rate);
      const sellRate = Number(data.sell_rate);
      return {
        rate,
        buyRate: Number.isFinite(buyRate) && buyRate > 0 ? buyRate : rate,
        sellRate: Number.isFinite(sellRate) && sellRate > 0 ? sellRate : rate,
      };
    } catch {
      return null;
    }
  },

  /**
   * Ensures the caller has a Quidax sub-account (creating one on first
   * call) and returns their LIVE wallet balances straight from Quidax —
   * this is the user's own held balance, not a KaysPay-tracked number.
   */
  async getOrCreateAccount(): Promise<{ success: boolean; wallets: QuidaxWalletBalance[]; error?: string }> {
    try {
      const { data, error } = await withTimeout(supabase.functions.invoke('crypto-account', { body: {} }));
      if (error) {
        let msg = 'Could not load your crypto account.';
        try {
          const errBody = await (error as any)?.context?.json?.();
          if (errBody?.error) msg = errBody.error;
        } catch {}
        return { success: false, wallets: [], error: msg };
      }
      if (!data?.success) return { success: false, wallets: [], error: data?.error || 'Could not load your crypto account.' };
      const wallets = (data.wallets ?? []).map((w: any) => ({
        currency: String(w.currency).toUpperCase(),
        balance: Number(w.balance) || 0,
        locked: Number(w.locked) || 0,
        isCrypto: !!w.is_crypto,
      }));
      return { success: true, wallets };
    } catch {
      return { success: false, wallets: [], error: 'Network error. Please try again.' };
    }
  },

  /** A deposit address on the user's own Quidax sub-account for the given network. */
  async getDepositAddress(network: CryptoNetwork): Promise<{ success: boolean; address?: string; error?: string }> {
    try {
      const { data, error } = await withTimeout(
        supabase.functions.invoke('crypto-deposit-address', { body: { network } }),
      );
      if (error) {
        let msg = 'Could not generate a deposit address.';
        try {
          const errBody = await (error as any)?.context?.json?.();
          if (errBody?.error) msg = errBody.error;
        } catch {}
        return { success: false, error: msg };
      }
      if (!data?.success) return { success: false, error: data?.error || 'Could not generate a deposit address.' };
      return { success: true, address: data.address };
    } catch {
      return { success: false, error: 'Network error. Please try again.' };
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

  /**
   * Live prices for the coin picker — one call covering every supported
   * coin's current NGN price and 24h change, straight from Quidax's own
   * order book. Purely informational: crypto-buy re-derives its own price
   * server-side at purchase time.
   */
  async getMarkets(): Promise<{ coins: MarketCoin[]; usdtNgnRate: number | null } | null> {
    try {
      const { data, error } = await withTimeout(supabase.functions.invoke('crypto-markets', { body: {} }));
      if (error || !data?.success) return null;
      const coins: MarketCoin[] = (data.coins ?? []).map((c: any) => ({
        code: c.code,
        name: c.name,
        stablecoin: !!c.stablecoin,
        priceNgn: Number(c.price_ngn) || 0,
        change24hPct: c.change_24h_pct != null ? Number(c.change_24h_pct) : null,
        openNgn: c.open_ngn != null ? Number(c.open_ngn) : null,
        lowNgn: c.low_ngn != null ? Number(c.low_ngn) : null,
        highNgn: c.high_ngn != null ? Number(c.high_ngn) : null,
      }));
      return { coins, usdtNgnRate: data.usdt_ngn_rate != null ? Number(data.usdt_ngn_rate) : null };
    } catch {
      return null;
    }
  },

  /**
   * Starts a purchase: Quidax issues a single-use bank account for the
   * customer to transfer Naira into. For USDT, Quidax delivers it either to
   * their own KaysPay crypto account (default) or a `destination` wallet
   * they supply. For any other supported coin, the USDT always lands in the
   * customer's own account first and is then swapped for the target coin
   * (`pendingSwap` in the result) — see crypto-buy/crypto-quidax-webhook.
   * Doesn't complete synchronously — the caller shows the returned bank
   * details and waits for the transfer + webhook(s), same as any
   * bank-transfer funding flow already in the app.
   */
  async buy(
    asset: BuyAsset,
    usdtAmount: number,
    authToken: string,
    destination?: { network: CryptoNetwork; address: string },
  ): Promise<CryptoBuyResult> {
    try {
      const idempotencyKey = newIdempotencyKey('crypto_buy');
      const { data, error } = await invokeWithRetry<any>(
        () => withTimeout(
          supabase.functions.invoke('crypto-buy', {
            body: {
              asset,
              usd_amount: usdtAmount,
              auth_token: authToken,
              idempotency_key: idempotencyKey,
              ...(destination
                ? { destination_network: destination.network, destination_address: destination.address }
                : {}),
            },
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
      return {
        success: true,
        transactionId: data.transaction_id,
        asset: data.asset,
        estimatedCrypto: Number(data.estimated_crypto) || 0,
        pendingSwap: !!data.pending_swap,
        destinationType: data.destination_type === 'external_wallet' ? 'external_wallet' : 'kayspay_account',
        destinationAddress: data.destination_address,
        payment: data.payment
          ? {
              accountName: data.payment.account_name,
              accountNumber: data.payment.account_number,
              bankName: data.payment.bank_name,
              amountToPay: Number(data.payment.amount_to_pay) || 0,
              amount: Number(data.payment.amount) || 0,
              processorFee: Number(data.payment.processor_fee) || 0,
              vat: Number(data.payment.vat) || 0,
              merchantMarkup: Number(data.payment.merchant_markup) || 0,
            }
          : undefined,
      };
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
      return {
        success: true,
        transactionId: data.transaction_id,
        pending: data.pending === true,
        message: data.message,
      };
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
      return {
        success: true,
        transactionId: data.transaction_id,
        pending: data.pending === true,
        message: data.message,
      };
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

  /**
   * Live status of a single Buy order — polled from the "Complete your
   * purchase" screen so the customer sees their crypto land the moment
   * crypto-ramp-webhook (or the reconcile sweep) settles it, instead of
   * having to manually reopen the screen to find out.
   */
  async getBuyOrderStatus(transactionId: string): Promise<{
    status: string;
    failureReason?: string;
    needsRefundBankDetails: boolean;
  } | null> {
    const { data } = await withTimeout(
      (async () => await supabase
        .from('transactions')
        .select('status, metadata')
        .eq('id', transactionId)
        .maybeSingle())(),
    );
    if (!data) return null;
    return {
      status: data.status,
      failureReason: data.metadata?.failure_reason,
      needsRefundBankDetails: data.metadata?.needs_refund_bank_details === true,
    };
  },

  /**
   * A pending Buy that Quidax auto-refunded (the paying bank account's name
   * didn't match) and is now waiting on the customer's own bank details.
   * Read directly off `transactions` rather than a dedicated endpoint —
   * this is the same table CryptoScreen already trusts RLS on for its own
   * history.
   */
  async getPendingBuyRefund(): Promise<{ transactionId: string; amountNgn: number } | null> {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return null;
    const { data } = await withTimeout(
      (async () => await supabase
        .from('transactions')
        .select('id, amount_ngn')
        .eq('user_id', user.id)
        .eq('type', 'crypto_buy')
        .eq('status', 'pending')
        .eq('metadata->>needs_refund_bank_details', 'true')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle())(),
    );
    if (!data) return null;
    return { transactionId: data.id, amountNgn: Number(data.amount_ngn) / 100 };
  },

  async listRefundBanks(): Promise<{ code: string; name: string }[]> {
    const { data, error } = await withTimeout(supabase.functions.invoke('crypto-banks', { body: {} }));
    if (error || !data?.success) return [];
    return (data.banks ?? []) as { code: string; name: string }[];
  },

  async resolveRefundAccount(
    transactionId: string,
    bankCode: string,
    accountNumber: string,
  ): Promise<{ success: boolean; accountName?: string; error?: string }> {
    try {
      const { data, error } = await withTimeout(
        supabase.functions.invoke('crypto-buy-refund-resolve', {
          body: { transaction_id: transactionId, bank_code: bankCode, account_number: accountNumber },
        }),
      );
      if (error) {
        const errBody = await (error as any)?.context?.json?.().catch(() => null);
        return { success: false, error: errBody?.error || 'Could not verify this account.' };
      }
      if (!data?.success) return { success: false, error: data?.error || 'Could not verify this account.' };
      return { success: true, accountName: data.account_name };
    } catch {
      return { success: false, error: 'Network error. Please try again.' };
    }
  },

  async submitRefundBank(
    transactionId: string,
    bankCode: string,
    accountNumber: string,
  ): Promise<{ success: boolean; accountName?: string; error?: string }> {
    try {
      const { data, error } = await withTimeout(
        supabase.functions.invoke('crypto-buy-refund-submit', {
          body: { transaction_id: transactionId, bank_code: bankCode, account_number: accountNumber },
        }),
      );
      if (error) {
        const errBody = await (error as any)?.context?.json?.().catch(() => null);
        return { success: false, error: errBody?.error || 'Could not submit your refund details.' };
      }
      if (!data?.success) return { success: false, error: data?.error || 'Could not submit your refund details.' };
      return { success: true, accountName: data.account_name };
    } catch {
      return { success: false, error: 'Network error. Please try again.' };
    }
  },
};
