import { supabase } from '../lib/supabase';
import type { Wallet, Transaction } from '../types/app.types';
import { koboToNaira } from '../utils/formatCurrency';
import { withTimeout } from '../utils/network';
import { safeErrorMessage } from '../utils/errorMessages';

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

export interface TransactionSummaryResult {
  success: boolean;
  totalTransactions?: number;
  totalSpent?: number;
  error?: string;
}

export interface NinePsbAccount {
  account_number: string;
  bank_name: string;
  account_name: string;
}

export interface NinePsbAccountResult {
  success: boolean;
  account?: NinePsbAccount | null;
  /** Set when setup was started (KYC-completion hook or the admin backfill) but the OTP step hasn't been completed yet. */
  pendingTransactionRef?: string | null;
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
      // getSession() reads the token from local storage — no network round
      // trip unless it's actually expired. getUser() always hits the Auth
      // server, adding a full extra round trip to every balance check on
      // top of the wallet query itself; useCachedData was fixed for this
      // exact reason (see its own comment) but this service still paid it.
      const { data: { session } } = await withTimeout(supabase.auth.getSession());
      const user = session?.user;
      if (!user) return { success: false, error: 'Not authenticated' };

      const { data, error } = await withTimeout(
        (async () => supabase.from('wallets').select('*').eq('user_id', user.id).maybeSingle())(),
      );

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
            cashback_balance: 0,
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
        cashback_balance: koboToNaira(data.cashback_balance_kobo ?? 0),
      };
      return { success: true, wallet };
    } catch (error: any) {
      return { success: false, error: safeErrorMessage(error) };
    }
  },

  /**
   * The customer's permanently-visible 9PSB account number, if one has been
   * provisioned (see supabase.migrations 228-232 and the 9PSB WAAS plan).
   * Returns success:true with account:null when nothing is active yet —
   * KYC not done, or provisioning/OTP not completed — so the caller can
   * fall back to today's layout with no special-casing of an error state.
   * RLS ("Users can view own virtual account") already scopes this to the
   * signed-in user's own row, same guarantee getWallet() relies on.
   */
  async getNinePsbAccount(): Promise<NinePsbAccountResult> {
    try {
      const { data: { session } } = await withTimeout(supabase.auth.getSession());
      const user = session?.user;
      if (!user) return { success: false, error: 'Not authenticated' };

      const { data, error } = await withTimeout(
        (async () => supabase
          .from('virtual_accounts')
          .select('status, account_number, bank_name, account_name, customer_code')
          .eq('user_id', user.id)
          .eq('provider', '9psb')
          .maybeSingle())(),
      );
      if (error) throw error;

      if (data?.status === 'active' && data.account_number) {
        return { success: true, account: data };
      }
      if (data?.status === 'pending_identity' && data.customer_code) {
        return { success: true, account: null, pendingTransactionRef: data.customer_code };
      }
      return { success: true, account: null };
    } catch (error: any) {
      return { success: false, error: safeErrorMessage(error) };
    }
  },

  async getRecentTransactions(limit: number = 10): Promise<TransactionResult> {
    try {
      const { data: { session } } = await withTimeout(supabase.auth.getSession());
      const user = session?.user;
      if (!user) return { success: false, error: 'Not authenticated' };

      const { data, error } = await withTimeout(
        (async () => supabase
          .from('transactions')
          .select('*')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false })
          .limit(limit))(),
      );

      if (error) throw error;

      // Convert each amount from kobo to naira for display.
      const transactions = (data || []).map((tx: any) => ({
        ...tx,
        amount_ngn: koboToNaira(tx.amount_ngn),
      }));
      return { success: true, transactions };
    } catch (error: any) {
      return { success: false, error: safeErrorMessage(error) };
    }
  },

  async getTransactionSummary(): Promise<TransactionSummaryResult> {
    try {
      const { data: { session } } = await withTimeout(supabase.auth.getSession());
      const user = session?.user;
      if (!user) return { success: false, error: 'Not authenticated' };

      const { data, error } = await withTimeout((async () => supabase.rpc('get_user_transaction_summary'))());
      if (error) throw error;

      const summary = data as { total_transactions?: unknown; total_spent_kobo?: unknown } | null;
      const totalTransactions = Number(summary?.total_transactions ?? 0);
      const totalSpentKobo = Number(summary?.total_spent_kobo ?? 0);
      if (!Number.isSafeInteger(totalTransactions) || !Number.isSafeInteger(totalSpentKobo)) {
        throw new Error('Invalid transaction summary');
      }

      return {
        success: true,
        totalTransactions,
        totalSpent: koboToNaira(totalSpentKobo),
      };
    } catch (error: unknown) {
      return { success: false, error: safeErrorMessage(error, 'Could not load transaction summary') };
    }
  },

  subscribeToBalance(
    callback: (balance: number) => void,
    onStatus?: (status: string) => void,
  ) {
    let subscription: any;
    let active = true;

    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      const user = session?.user;
      if (!user || !active) return;

      subscription = supabase
        .channel(`wallet-changes:${user.id}`)
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
        .subscribe((status) => {
          if (active) onStatus?.(status);
        });
    })();

    return {
      unsubscribe: () => {
        active = false;
        subscription?.unsubscribe();
      },
    };
  },
};
