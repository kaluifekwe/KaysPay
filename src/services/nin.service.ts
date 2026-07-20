import { supabase } from '../lib/supabase';
import { withTimeout, invokeWithRetry } from '../utils/network';

export interface NinRecord {
  firstname?: string;
  middlename?: string;
  surname?: string;
  telephoneno?: string;
  residence_state?: string;
  residence_town?: string;
  residence_address?: string;
  residence_lga?: string;
  gender?: string;
  nin?: string;
  birthdate?: string;
  photo?: string; // base64
  trackingId?: string; // not returned by Prembly today; kept for slip-layout compatibility
}

export interface NinVerifyClaim {
  firstname?: string;
  surname?: string;
  gender?: string;
  birthdate?: string; // YYYY-MM-DD
}

export interface NinVerifyResult {
  success: boolean;
  transaction_id?: string;
  record?: NinRecord;
  matches?: Record<string, boolean>;
  error?: string;
}

export interface NinValidateResult {
  success: boolean;
  pending?: boolean;
  transaction_id?: string;
  message?: string;
  error?: string;
}

export interface BvnRecord {
  firstname?: string;
  middlename?: string;
  lastname?: string;
  phone?: string;
  dob?: string;
  gender?: string;
  bvn?: string;
  photo?: string;
  stateOfOrigin?: string; // only present when CheckMyNINBVN answers
  stateOfResidence?: string; // only present when CheckMyNINBVN answers
}

export interface BvnVerifyResult {
  success: boolean;
  transaction_id?: string;
  record?: BvnRecord;
  error?: string;
}

export type NinModificationType = 'name' | 'phone' | 'address';

export interface NinModificationFields {
  nin: string;
  surname: string;
  firstname: string;
  phone_number?: string;
  middlename?: string;
  new_surname?: string;
  new_firstname?: string;
  new_phone_number?: string;
  new_address?: string;
}

export interface NinModifyResult {
  success: boolean;
  pending?: boolean;
  transaction_id?: string;
  message?: string;
  error?: string;
}

function newIdempotencyKey(): string {
  return `ksp_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export const ninService = {
  /**
   * Verifies a NIN against NIMC's database, optionally comparing it against
   * caller-submitted details (name/gender/DOB) — the "does this match"
   * check used by banks/schools/agents. Also the data source for the
   * printable slip/card view.
   */
  async verifyNin(nin: string, claimed: NinVerifyClaim | undefined, authToken: string): Promise<NinVerifyResult> {
    try {
      const idempotencyKey = newIdempotencyKey();
      const { data, error } = await invokeWithRetry<any>(
        () =>
          withTimeout(
            supabase.functions.invoke('nin-verify', {
              body: { nin, claimed, auth_token: authToken, idempotency_key: idempotencyKey },
            }),
          ),
        idempotencyKey,
      );
      if (error) {
        let msg = 'Service temporarily unavailable. Please try again.';
        try {
          const errBody = await (error as any)?.context?.json?.();
          if (errBody?.error) msg = errBody.error;
        } catch {}
        return { success: false, error: msg };
      }
      if (!data?.success) {
        return { success: false, error: data?.error || 'Could not verify this NIN' };
      }
      return { success: true, transaction_id: data.transaction_id, record: data.record, matches: data.matches };
    } catch {
      return { success: false, error: 'Network error. Please try again.' };
    }
  },

  /**
   * Submits a request confirming a NIN is genuinely issued/active — an
   * async, reviewed order (24-48h), not an instant result.
   */
  async submitValidation(nin: string, dateOfBirth: string, authToken: string): Promise<NinValidateResult> {
    try {
      const idempotencyKey = newIdempotencyKey();
      const { data, error } = await invokeWithRetry<any>(
        () =>
          withTimeout(
            supabase.functions.invoke('nin-validate', {
              body: { nin, date_of_birth: dateOfBirth, auth_token: authToken, idempotency_key: idempotencyKey },
            }),
          ),
        idempotencyKey,
      );
      if (error) {
        let msg = 'Service temporarily unavailable. Please try again.';
        try {
          const errBody = await (error as any)?.context?.json?.();
          if (errBody?.error) msg = errBody.error;
        } catch {}
        return { success: false, error: msg };
      }
      if (!data?.success) {
        return { success: false, error: data?.error || 'Could not submit validation request' };
      }
      return { success: true, pending: data.pending, transaction_id: data.transaction_id, message: data.message };
    } catch {
      return { success: false, error: 'Network error. Please try again.' };
    }
  },

  /** Verifies a BVN against the bank's on-file record. */
  async verifyBvn(bvn: string, authToken: string): Promise<BvnVerifyResult> {
    try {
      const idempotencyKey = newIdempotencyKey();
      const { data, error } = await invokeWithRetry<any>(
        () =>
          withTimeout(
            supabase.functions.invoke('bvn-verify', {
              body: { bvn, auth_token: authToken, idempotency_key: idempotencyKey },
            }),
          ),
        idempotencyKey,
      );
      if (error) {
        let msg = 'Service temporarily unavailable. Please try again.';
        try {
          const errBody = await (error as any)?.context?.json?.();
          if (errBody?.error) msg = errBody.error;
        } catch {}
        return { success: false, error: msg };
      }
      if (!data?.success) {
        return { success: false, error: data?.error || 'Could not verify this BVN' };
      }
      return { success: true, transaction_id: data.transaction_id, record: data.record };
    } catch {
      return { success: false, error: 'Network error. Please try again.' };
    }
  },

  /**
   * Submits a NIN correction request (name/phone/address) to NIMC — an
   * async, reviewed order (24-48h), not an instant result. The fee is
   * charged upfront and only refunded if the order is rejected.
   */
  async submitModification(
    type: NinModificationType,
    fields: NinModificationFields,
    authToken: string,
  ): Promise<NinModifyResult> {
    try {
      const idempotencyKey = newIdempotencyKey();
      const { data, error } = await invokeWithRetry<any>(
        () =>
          withTimeout(
            supabase.functions.invoke('nin-modify', {
              body: { modification_type: type, ...fields, auth_token: authToken, idempotency_key: idempotencyKey },
            }),
          ),
        idempotencyKey,
      );
      if (error) {
        let msg = 'Service temporarily unavailable. Please try again.';
        try {
          const errBody = await (error as any)?.context?.json?.();
          if (errBody?.error) msg = errBody.error;
        } catch {}
        return { success: false, error: msg };
      }
      if (!data?.success) {
        return { success: false, error: data?.error || 'Could not submit this request' };
      }
      return { success: true, pending: data.pending, transaction_id: data.transaction_id, message: data.message };
    } catch {
      return { success: false, error: 'Network error. Please try again.' };
    }
  },
};
