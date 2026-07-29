import { supabase } from '../lib/supabase';
import type { Wallet, Transaction } from '../types/app.types';
import { koboToNaira } from '../utils/formatCurrency';

export interface WalletResult {
  success: boolean;
  wallet?: Wallet;
  error?: string;
}

export interface TransactionResult {
  success: boolean;
  transactions?: Transaction[];
  error?: string;
}

/**
 * The wallet is server-authoritative. The client may only READ its balance
 * and history and subscribe to realtime changes. Every credit/debit happens
 * inside an Edge Function (paystack-verify, vtu-purchase, paystack-transfer)
 * via atomic, row-locked Postgres functions — direct client writes to the
 * `wallets`/`transactions` tables are revoked at the database level.
 */
export const walletService = {
  async getWallet(): Promise<WalletResult> {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return { success: false, error: 'Not authenticated' };

      const { data, error } = await supabase
        .from('wallets')
        .select('*')
        .eq('user_id', user.id)
        .maybeSingle();

      if (error) throw error;

      // A brand-new user's wallet row may not exist yet — it's created
      // server-side on the first credit. That's a genuinely empty wallet (₦0),
      // NOT a load failure, so return zero instead of surfacing "Couldn't load
      // balance". A real network/RLS error still throws above and keeps the
      // retry state, so "empty" and "couldn't check" don't get conflated.
      if (!data) {
        return {
          success: true,
          wallet: {
            id: '',
            user_id: user.id,
            balance: 0,
            locked_amount: 0,
            available_balance: 0,
            updated_at: new Date().toISOString(),
          },
        };
      }

      // Server stores kobo; expose naira to the rest of the app.
      const wallet = {
        ...data,
        balance: koboToNaira(data.balance),
        locked_amount: koboToNaira(data.locked_amount),
        available_balance: koboToNaira(data.available_balance),
      };
      return { success: true, wallet };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  },

  async getRecentTransactions(limit: number = 10): Promise<TransactionResult> {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return { success: false, error: 'Not authenticated' };

      const { data, error } = await supabase
        .from('transactions')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(limit);

      if (error) throw error;

      // Convert each amount from kobo to naira for display.
      const transactions = (data || []).map((tx: any) => ({
        ...tx,
        amount_ngn: koboToNaira(tx.amount_ngn),
      }));
      return { success: true, transactions };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  },

  subscribeToBalance(callback: (balance: number) => void) {
    let subscription: any;

    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      subscription = supabase
        .channel('wallet-changes')
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'wallets',
            filter: `user_id=eq.${user.id}`,
          },
          (payload) => {
            if (payload.new) {
              callback(koboToNaira((payload.new as any).balance));
            }
          }
        )
        .subscribe();
    })();

    return {
      unsubscribe: () => {
        subscription?.unsubscribe();
      },
    };
  },
};
