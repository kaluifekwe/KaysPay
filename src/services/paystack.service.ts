import { supabase } from '../lib/supabase';
import { koboToNaira, nairaToKobo } from '../utils/formatCurrency';

// supabase-js hides an Edge Function's JSON error body behind a generic
// "Edge Function returned a non-2xx status code" message on any FunctionsError.
// Dig out the function's own { error: "..." } body so the user sees the real reason.
async function extractFunctionError(error: any, fallback: string): Promise<string> {
  try {
    const body = await error?.context?.json?.();
    if (body?.error) return body.error;
  } catch {}
  return error?.message || fallback;
}

// A dropped/stalled mobile connection can leave a fetch() pending forever with
// no error and no response — the UI would spin indefinitely with no way out.
// Race it against a timeout so the user always gets a result. Note this
// doesn't cancel the in-flight request: if it does eventually succeed on the
// server after we've given up waiting, that's fine — withdrawals are
// idempotency-keyed, so a manual retry afterward can't double-debit.
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Request timed out. Please check your connection and try again.')),
      ms,
    );
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

export interface PaystackInitResult {
  success: boolean;
  authorization_url?: string;
  reference?: string;
  error?: string;
}

export interface PaystackVerifyResult {
  success: boolean;
  data?: {
    id: number;
    reference: string;
    amount: number;
    status: string;
    gateway_response: string;
    paid_at: string;
    channel: string;
  };
  error?: string;
}

export interface Bank {
  name: string;
  code: string;
  longcode: string;
  slug: string;
}

export interface ResolveAccountResult {
  success: boolean;
  data?: {
    account_name: string;
    account_number: string;
    bank_code: string;
  };
  error?: string;
}

export interface TransferResult {
  success: boolean;
  data?: {
    reference: string;
    transfer_code: string;
    status: string;
    new_balance: number;
    withdrawal_id: string;
  };
  error?: string;
}

export const paystackService = {
  async initializeTransaction(
    email: string,
    amountInNaira: number,
    reference: string,
    callbackUrl?: string,
  ): Promise<PaystackInitResult> {
    try {
      const { data, error } = await supabase.functions.invoke('paystack-init', {
        body: {
          email,
          amount: nairaToKobo(amountInNaira), // server + Paystack work in kobo
          reference,
          callback_url: callbackUrl,
        },
      });

      if (error) throw error;

      if (!data.status) {
        return { success: false, error: data.error || 'Failed to initialize payment' };
      }

      return {
        success: true,
        authorization_url: data.authorization_url,
        reference: data.reference,
      };
    } catch (error: any) {
      return { success: false, error: error.message || 'Network error' };
    }
  },

  async verifyTransaction(reference: string): Promise<PaystackVerifyResult> {
    try {
      const { data, error } = await withTimeout(
        supabase.functions.invoke('paystack-verify', { body: { reference } }),
        30000,
      );

      if (error) {
        return { success: false, error: await extractFunctionError(error, 'Network error') };
      }

      if (!data.status) {
        return { success: false, error: data.error || 'Verification failed' };
      }

      // Server returns kobo; expose naira to the app.
      const d = data.data;
      return {
        success: true,
        data: {
          ...d,
          amount: koboToNaira(d.amount),
          balance: d.balance != null ? koboToNaira(d.balance) : d.balance,
        },
      };
    } catch (error: any) {
      return { success: false, error: error.message || 'Network error' };
    }
  },

  async listBanks(): Promise<{ success: boolean; banks?: Bank[]; error?: string }> {
    try {
      const { data, error } = await supabase.functions.invoke('paystack-banks', {});

      if (error) {
        return { success: false, error: await extractFunctionError(error, 'Failed to fetch banks') };
      }

      if (!data.status) {
        return { success: false, error: data.error || 'Failed to fetch banks' };
      }

      return { success: true, banks: data.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Network error' };
    }
  },

  async resolveAccount(
    accountNumber: string,
    bankCode: string
  ): Promise<ResolveAccountResult> {
    try {
      const { data, error } = await supabase.functions.invoke('paystack-resolve-account', {
        body: { account_number: accountNumber, bank_code: bankCode },
      });

      if (error) {
        return { success: false, error: await extractFunctionError(error, 'Account resolution failed') };
      }

      if (!data.status) {
        return { success: false, error: data.error || 'Account resolution failed' };
      }

      return { success: true, data: data.data };
    } catch (error: any) {
      return { success: false, error: error.message || 'Network error' };
    }
  },

  async initiateTransfer(params: {
    user_id?: string; // ignored server-side; the withdrawing user is taken from the JWT
    amount: number;
    account_number: string;
    bank_code: string;
    account_name: string;
    bank_name: string;
    idempotency_key?: string; // dedupes double-tapped / retried withdrawals
    authToken: string;
  }): Promise<TransferResult> {
    try {
      const { authToken, ...rest } = params;
      const { data, error } = await withTimeout(
        supabase.functions.invoke('paystack-transfer', {
          body: { ...rest, amount: nairaToKobo(params.amount), auth_token: authToken },
        }),
        30000,
      );

      if (error) {
        return { success: false, error: await extractFunctionError(error, 'Transfer failed') };
      }

      if (!data.status) {
        return { success: false, error: data.error || 'Transfer failed' };
      }

      const d = data.data;
      return {
        success: true,
        data: {
          ...d,
          new_balance: d.new_balance != null ? koboToNaira(d.new_balance) : d.new_balance,
        },
      };
    } catch (error: any) {
      return { success: false, error: error.message || 'Network error' };
    }
  },

  calculateFee(amount: number): number {
    if (amount <= 5000) return 10;
    if (amount <= 50000) return 25;
    return 50;
  },
};
