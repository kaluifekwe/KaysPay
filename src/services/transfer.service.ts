import { supabase } from '../lib/supabase';
import { withTimeout, invokeWithRetry } from '../utils/network';

// Wallet Transfer (phase 1, Flutterwave): sends real NGN from the
// customer's KaysPay wallet balance to an external bank account. The
// first outbound-money feature in the app — see supabase/functions/
// transfer-send, transfer-resolve-account, transfer-banks.

// MUST stay strictly alphanumeric (no underscores, dashes or dots):
// transfer-send passes this straight through as Flutterwave's `reference`,
// and Flutterwave rejects anything else outright with "reference: must be
// an alphanumeric string". It doubles as our own idempotency key and is
// what the settlement webhook matches on, so the two can never diverge —
// one id, one meaning, everywhere.
function newIdempotencyKey(prefix: string): string {
  return `${prefix}${Date.now()}${Math.random().toString(36).slice(2, 10)}`;
}

export interface TransferBank {
  code: string;
  name: string;
}

export interface ResolveAccountResult {
  success: boolean;
  accountName?: string;
  error?: string;
}

export interface SendTransferResult {
  success: boolean;
  error?: string;
  transactionId?: string;
  // Transfer never settles synchronously — a successful call only means the
  // request was accepted; the webhook is what confirms it actually landed.
  pending?: boolean;
  message?: string;
  recipientName?: string;
}

async function extractErrorMessage(error: unknown, fallback: string): Promise<string> {
  try {
    const errBody = await (error as any)?.context?.json?.();
    if (errBody?.error) return errBody.error;
  } catch {}
  return fallback;
}

export const transferService = {
  /**
   * Client visibility for Wallet Transfer. The raw service-controls table is
   * never exposed to the app; the RPC only answers for explicitly whitelisted
   * features. Transfer endpoints still enforce the switch server-side.
   *
   * Fail closed: if availability cannot be confirmed, do not expose a
   * cash-out flow that may be disabled.
   */
  async isEnabled(): Promise<boolean> {
    try {
      const { data, error } = await withTimeout(
        (async () => supabase.rpc('is_client_feature_enabled', { p_service: 'transfer' }))(),
      );
      return !error && data === true;
    } catch {
      return false;
    }
  },

  async listBanks(): Promise<{ success: boolean; banks: TransferBank[]; error?: string }> {
    try {
      const { data, error } = await withTimeout(supabase.functions.invoke('transfer-banks', { body: {} }));
      if (error) {
        return { success: false, banks: [], error: await extractErrorMessage(error, 'Could not load the bank list.') };
      }
      if (!data?.success) return { success: false, banks: [], error: data?.error || 'Could not load the bank list.' };
      return { success: true, banks: (data.banks ?? []) as TransferBank[] };
    } catch {
      return { success: false, banks: [], error: 'Network error. Please try again.' };
    }
  },

  async resolveAccount(bankCode: string, accountNumber: string): Promise<ResolveAccountResult> {
    try {
      const { data, error } = await withTimeout(
        supabase.functions.invoke('transfer-resolve-account', {
          body: { bank_code: bankCode, account_number: accountNumber },
        }),
      );
      if (error) {
        return { success: false, error: await extractErrorMessage(error, 'Could not verify this account.') };
      }
      if (!data?.success) return { success: false, error: data?.error || 'Could not verify this account.' };
      return { success: true, accountName: data.account_name };
    } catch {
      return { success: false, error: 'Network error. Please try again.' };
    }
  },

  /**
   * Sends a transfer. Doesn't complete synchronously — the caller should
   * treat any `success: true` response as "accepted, wait for it to
   * settle" (surfaced via `pending`), same as crypto Buy's bank-transfer
   * flow already does.
   */
  async send(params: {
    bankCode: string;
    bankName: string;
    accountNumber: string;
    amount: number;
    authToken: string;
  }): Promise<SendTransferResult> {
    try {
      const idempotencyKey = newIdempotencyKey('transfer');
      const { data, error } = await invokeWithRetry<any>(
        () => withTimeout(
          supabase.functions.invoke('transfer-send', {
            body: {
              bank_code: params.bankCode,
              bank_name: params.bankName,
              account_number: params.accountNumber,
              amount: params.amount,
              auth_token: params.authToken,
              idempotency_key: idempotencyKey,
            },
          }),
        ),
        idempotencyKey,
      );
      if (error) {
        return { success: false, error: await extractErrorMessage(error, 'Transfer failed. Please try again.') };
      }
      if (!data?.success) return { success: false, error: data?.error || 'Transfer failed.' };
      return {
        success: true,
        transactionId: data.transaction_id,
        pending: !!data.pending,
        message: data.message,
        recipientName: data.recipient_name,
      };
    } catch {
      return { success: false, error: 'Network error. Please try again.' };
    }
  },
};
