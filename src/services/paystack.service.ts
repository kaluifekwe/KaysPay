import { supabase } from '../lib/supabase';
import { koboToNaira, nairaToKobo } from '../utils/formatCurrency';
import { withTimeout, invokeWithRetry } from '../utils/network';

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
      const { data, error } = await withTimeout(
        supabase.functions.invoke('paystack-init', {
          body: {
            email,
            amount: nairaToKobo(amountInNaira), // server + Paystack work in kobo
            reference,
            callback_url: callbackUrl,
          },
        }),
      );

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
      const { data, error } = await withTimeout(supabase.functions.invoke('paystack-banks', {}));

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
      const { data, error } = await withTimeout(
        supabase.functions.invoke('paystack-resolve-account', {
          body: { account_number: accountNumber, bank_code: bankCode },
        }),
      );

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
      // Always guaranteed even though the type marks it optional — needed
      // to safely recover from an ambiguous network failure below.
      const idempotencyKey = params.idempotency_key || `kpwd_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      const { data, error } = await invokeWithRetry<any>(
        () =>
          withTimeout(
            supabase.functions.invoke('paystack-transfer', {
              body: { ...rest, idempotency_key: idempotencyKey, amount: nairaToKobo(params.amount), auth_token: authToken },
            }),
            30000,
          ),
        idempotencyKey,
        {
          table: 'withdrawals',
          keyColumn: 'idempotency_key',
          // paystack-transfer's real success shape is { status: true, data:
          // {...} } (mirrors Paystack's own API), not { success: true } like
          // the other purchase-type functions — match it so the downstream
          // `if (!data.status)` check below reads a recovered outcome
          // correctly instead of misreading it as a failure.
          buildRecovered: (outcome) => ({
            status: true,
            data: { status: outcome === 'pending' ? 'processing' : 'success' },
          }),
        },
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
