import { supabase } from '../lib/supabase';
import { withTimeout } from '../utils/network';

export interface SendCodeResult {
  success: boolean;
  sentTo?: string;
  error?: string;
  /** Machine-readable reason when success is false. 'RATE_LIMITED' means a
   * code was already sent within the last minute and is still valid — the
   * caller should show the code input, never an error screen that hides it. */
  code?: string;
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

/**
 * Both send-email-otp and verify-email-otp require the caller's session on the
 * server (getAuthUser). This screen runs the moment the email-verify gate
 * mounts — right after signUp — where the functions client may not have the
 * new access token wired up yet, so the call would arrive unauthenticated and
 * 401 ("no email during signup", while password reset — which needs no auth —
 * worked fine). Resolve the session (refreshing if needed) and attach the token
 * explicitly so the call is always authenticated.
 */
async function authedHeaders(): Promise<Record<string, string> | undefined> {
  try {
    let { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) {
      try { await supabase.auth.refreshSession(); } catch {}
      ({ data: { session } } = await supabase.auth.getSession());
    }
    return session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : undefined;
  } catch {
    return undefined;
  }
}

// Verifies the signup email itself — the only thing this system does. Email
// and phone are fixed at signup and never user-editable afterward.
export const emailVerificationService = {
  async sendCode(): Promise<SendCodeResult> {
    try {
      const headers = await authedHeaders();
      const { data, error } = await withTimeout(supabase.functions.invoke('send-email-otp', { body: {}, headers }));
      if (error) {
        return { success: false, error: await unwrapError(error, 'Could not send verification code. Please try again.') };
      }
      if (!data?.success) {
        return { success: false, error: data?.error || 'Could not send verification code.', code: data?.code };
      }
      return { success: true, sentTo: data.sent_to };
    } catch {
      return { success: false, error: 'Network error. Please try again.' };
    }
  },

  async verifyCode(code: string): Promise<VerifyCodeResult> {
    try {
      const headers = await authedHeaders();
      const { data, error } = await withTimeout(supabase.functions.invoke('verify-email-otp', { body: { code }, headers }));
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
