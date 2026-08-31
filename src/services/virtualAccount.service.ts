import { supabase } from '../lib/supabase';
import { withTimeout } from '../utils/network';
import { safeErrorMessage } from '../utils/errorMessages';

export type VirtualAccountProvider = 'flutterwave' | 'paystack';

export interface VirtualAccount {
  account_number: string;
  bank_name: string;
  account_name: string;
}

export interface VirtualAccountResult {
  success: boolean;
  account?: VirtualAccount;
  error?: string;
}

export interface VirtualAccountRequeryResult {
  success: boolean;
  message?: string;
  error?: string;
}

export const virtualAccountService = {
  /**
   * Returns the user's existing dedicated accounts, one per provider (null
   * where not yet created). A user may hold an account from either or both
   * providers at once — whichever gets funded credits the same wallet.
   */
  async getAllMine(): Promise<Record<VirtualAccountProvider, VirtualAccount | null>> {
    const empty: Record<VirtualAccountProvider, VirtualAccount | null> = { flutterwave: null, paystack: null };
    try {
      const { data: { user } } = await withTimeout(supabase.auth.getUser());
      if (!user) return empty;
      const { data } = await withTimeout(
        (async () => supabase
          .from('virtual_accounts')
          .select('provider, account_number, bank_name, account_name')
          .eq('user_id', user.id))(),
      );
      for (const row of data ?? []) {
        if (row.account_number && (row.provider === 'flutterwave' || row.provider === 'paystack')) {
          empty[row.provider as VirtualAccountProvider] = row as VirtualAccount;
        }
      }
      return empty;
    } catch {
      return empty;
    }
  },

  /**
   * Creates (or returns the existing) dedicated NUBAN for the given provider
   * via the Edge Function. `bvnOrNin` is required the first time an account
   * is created for that provider; not needed on subsequent calls (already
   * provisioned).
   */
  async create(provider: VirtualAccountProvider, bvnOrNin?: string): Promise<VirtualAccountResult> {
    try {
      const { data, error } = await withTimeout(
        supabase.functions.invoke('create-virtual-account', {
          body: bvnOrNin ? { provider, bvn_or_nin: bvnOrNin } : { provider },
        }),
      );
      if (error) {
        let msg = safeErrorMessage(error, 'Could not set up your account');
        try {
          const body = await (error as any)?.context?.json?.();
          if (body?.error) msg = String(body.error);
        } catch {}
        return { success: false, error: msg };
      }
      if (!data?.success) {
        return { success: false, error: data?.error || 'Could not set up your account' };
      }
      return { success: true, account: data.account };
    } catch (e: any) {
      return { success: false, error: e?.message || 'Network error' };
    }
  },

  async requeryPaystack(): Promise<VirtualAccountRequeryResult> {
    try {
      const { data, error } = await withTimeout(
        supabase.functions.invoke('requery-paystack-dva', { body: {} }),
      );
      if (error) {
        let message = safeErrorMessage(error, 'Could not check the transfer');
        try {
          const body = await (error as any)?.context?.json?.();
          if (body?.error) message = String(body.error);
        } catch {}
        return { success: false, error: message };
      }
      return data?.success
        ? { success: true, message: data.message }
        : { success: false, error: data?.error || 'Could not check the transfer' };
    } catch (error: unknown) {
      return {
        success: false,
        error: safeErrorMessage(error, 'Network error'),
      };
    }
  },
};
