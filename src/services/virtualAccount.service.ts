import { supabase } from '../lib/supabase';

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

export const virtualAccountService = {
  /** Returns the user's existing dedicated account, or null if not yet created. */
  async getMine(): Promise<VirtualAccount | null> {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return null;
      const { data } = await supabase
        .from('virtual_accounts')
        .select('account_number, bank_name, account_name')
        .eq('user_id', user.id)
        .maybeSingle();
      return data?.account_number ? (data as VirtualAccount) : null;
    } catch {
      return null;
    }
  },

  /** Creates (or returns the existing) dedicated NUBAN via the Edge Function. */
  async create(): Promise<VirtualAccountResult> {
    try {
      const { data, error } = await supabase.functions.invoke('create-virtual-account', {
        body: {},
      });
      if (error) {
        let msg = error.message || 'Could not set up your account';
        try {
          const body = await (error as any)?.context?.json?.();
          if (body?.error) msg = body.error;
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
};
