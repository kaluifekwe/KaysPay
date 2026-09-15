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
  /** 9PSB only — Call 1 succeeded but setup isn't finished until verifyNinePsbOtp() completes Call 2. */
  requiresOtp?: boolean;
  transactionRef?: string;
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
    const { data: { user } } = await withTimeout(supabase.auth.getUser());
    if (!user) return empty;
    const { data, error } = await withTimeout(
      (async () => supabase
        .from('virtual_accounts')
        .select('provider, account_number, bank_name, account_name')
        .eq('user_id', user.id))(),
    );
    // Thrown (timeout) or returned errors both propagate now instead of
    // being swallowed into "no accounts" — this is only ever called via
    // useCachedData (WalletFundingScreen), which exists specifically to
    // catch a failure here and keep showing the last-known-good account
    // list instead of wrongly telling an already-provisioned user they
    // still need to create one.
    if (error) throw error;
    for (const row of data ?? []) {
      if (row.account_number && (row.provider === 'flutterwave' || row.provider === 'paystack')) {
        empty[row.provider as VirtualAccountProvider] = row as VirtualAccount;
      }
    }
    return empty;
  },

  /**
   * Creates (or returns the existing) dedicated NUBAN for the given provider
   * via the Edge Function. `bvnOrNin` is required the first time an account
   * is created for that provider; not needed on subsequent calls (already
   * provisioned).
   */
  async create(provider: VirtualAccountProvider | '9psb', bvnOrNin?: string): Promise<VirtualAccountResult> {
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
      if (data.requires_otp) {
        return { success: true, requiresOtp: true, transactionRef: data.transaction_ref };
      }
      return { success: true, account: data.account };
    } catch (e: unknown) {
      return { success: false, error: safeErrorMessage(e, 'Network error') };
    }
  },

  /** 9PSB Call 2 — same create-virtual-account function, now with the OTP that finishes wallet setup. */
  async verifyNinePsbOtp(transactionRef: string, otp: string): Promise<VirtualAccountResult> {
    try {
      const { data, error } = await withTimeout(
        supabase.functions.invoke('create-virtual-account', {
          body: { provider: '9psb', transaction_ref: transactionRef, otp },
        }),
      );
      if (error) {
        let msg = safeErrorMessage(error, 'That code didn’t work');
        try {
          const body = await (error as any)?.context?.json?.();
          if (body?.error) msg = String(body.error);
        } catch {}
        return { success: false, error: msg };
      }
      if (!data?.success) {
        return { success: false, error: data?.error || 'That code didn’t work' };
      }
      return { success: true, account: data.account };
    } catch (e: unknown) {
      return { success: false, error: safeErrorMessage(e, 'Network error') };
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
