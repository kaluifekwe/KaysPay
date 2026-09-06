import { supabase } from '../lib/supabase';
import { withTimeout } from '../utils/network';

export interface KycStatus {
  verified: boolean;
  verifiedName?: string;
  /** The verified NIN or BVN, whichever the user actually verified with —
   *  own data, RLS-scoped to the caller. Lets callers (e.g. wallet funding)
   *  reuse an already-verified identity instead of asking the user to type
   *  their BVN/NIN a second time; Flutterwave's account-creation API
   *  accepts either identifier interchangeably, so callers never need to
   *  know which one this actually is. */
  verifiedNin?: string;
  /** Set when the status couldn't actually be checked (network/timeout) —
   *  `verified` is just the safe default in that case, not a real answer.
   *  Callers that gate on `verified === false` should check this first and
   *  keep whatever they last knew instead of treating a blip as a genuine
   *  "not verified" (see WalletFundingScreen/CryptoScreen/CryptoBuyScreen). */
  checkFailed?: boolean;
}

export interface KycVerifyResult {
  success: boolean;
  verifiedName?: string;
  error?: string;
}

async function unwrapError(error: any, fallback: string): Promise<string> {
  try {
    const errBody = await error?.context?.json?.();
    if (errBody?.error) return errBody.error;
  } catch {}
  return fallback;
}

export const kycService = {
  /** Reads the caller's own row directly (RLS scopes it) — no Edge Function needed for a read. */
  async getStatus(): Promise<KycStatus> {
    try {
      const { data } = await withTimeout(
        (async () => supabase.from('user_kyc').select('status, nin, bvn, verified_record').maybeSingle())(),
      );
      if (!data || data.status !== 'verified') return { verified: false };
      const record = data.verified_record as any;
      const verifiedName = [record?.firstname, record?.middlename, record?.surname].filter(Boolean).join(' ');
      return {
        verified: true,
        verifiedName: verifiedName || undefined,
        verifiedNin: data.nin || data.bvn || undefined,
      };
    } catch {
      // Couldn't reach the server (timeout/dropped connection) — not the
      // same thing as a confirmed "not verified". See checkFailed above.
      return { verified: false, checkFailed: true };
    }
  },

  async verifyNin(nin: string): Promise<KycVerifyResult> {
    try {
      const { data, error } = await withTimeout(
        supabase.functions.invoke('kyc-verify-nin', { body: { nin } }),
      );
      if (error) {
        return { success: false, error: await unwrapError(error, 'Could not verify this NIN. Please try again.') };
      }
      if (!data?.success) {
        return { success: false, error: data?.error || 'Could not verify this NIN.' };
      }
      return { success: true, verifiedName: data.verified_name };
    } catch {
      return { success: false, error: 'Network error. Please try again.' };
    }
  },

  /** Same free, no-wallet-debit check as verifyNin, keyed on BVN instead — same edge function, different body field. */
  async verifyBvn(bvn: string): Promise<KycVerifyResult> {
    try {
      const { data, error } = await withTimeout(
        supabase.functions.invoke('kyc-verify-nin', { body: { bvn } }),
      );
      if (error) {
        return { success: false, error: await unwrapError(error, 'Could not verify this BVN. Please try again.') };
      }
      if (!data?.success) {
        return { success: false, error: data?.error || 'Could not verify this BVN.' };
      }
      return { success: true, verifiedName: data.verified_name };
    } catch {
      return { success: false, error: 'Network error. Please try again.' };
    }
  },
};
