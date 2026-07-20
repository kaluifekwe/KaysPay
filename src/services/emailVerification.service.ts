import { supabase } from '../lib/supabase';
import { withTimeout } from '../utils/network';

export interface SendCodeResult {
  success: boolean;
  sentTo?: string;
  error?: string;
}

export interface VerifyCodeResult {
  success: boolean;
  attemptsRemaining?: number;
  error?: string;
}

async function unwrapError(error: any, fallback: string): Promise<string> {
  try {
    const errBody = await error?.context?.json?.();
    if (errBody?.error) return errBody.error;
  } catch {}
  return fallback;
}

// Verifies the signup email itself — the only thing this system does. Email
// and phone are fixed at signup and never user-editable afterward.
export const emailVerificationService = {
  async sendCode(): Promise<SendCodeResult> {
    try {
      const { data, error } = await withTimeout(supabase.functions.invoke('send-email-otp', { body: {} }));
      if (error) {
        return { success: false, error: await unwrapError(error, 'Could not send verification code. Please try again.') };
      }
      if (!data?.success) {
        return { success: false, error: data?.error || 'Could not send verification code.' };
      }
      return { success: true, sentTo: data.sent_to };
    } catch {
      return { success: false, error: 'Network error. Please try again.' };
    }
  },

  async verifyCode(code: string): Promise<VerifyCodeResult> {
    try {
      const { data, error } = await withTimeout(supabase.functions.invoke('verify-email-otp', { body: { code } }));
      if (error) {
        return { success: false, error: await unwrapError(error, 'Could not verify code. Please try again.') };
      }
      if (!data?.success) {
        return { success: false, error: data?.error || 'Incorrect code. Please try again.', attemptsRemaining: data?.attempts_remaining };
      }
      return { success: true };
    } catch {
      return { success: false, error: 'Network error. Please try again.' };
    }
  },
};
