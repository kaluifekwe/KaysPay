import * as SecureStore from 'expo-secure-store';
import { supabase } from '../lib/supabase';
import { storageHelpers, StorageKeys } from '../lib/mmkv';
import { clearAllCache } from '../utils/cache';
import { passwordValidationError } from '../utils/password';
import { withTimeout } from '../utils/network';

export interface AuthResult {
  success: boolean;
  error?: string;
}

// SecureStore key holding the PIN captured during signup until it can be
// persisted server-side once the session is fully established (see
// stashSignupPin / ensurePinSaved). Scoped per-account (user id suffix) so a
// PIN stashed for one account can never be read back and silently adopted by
// a different account signed in later on the same device.
const pendingPinKey = (userId: string) => `pending_signup_pin:${userId}`;

// Separate stash, same shape as pendingPinKey above: holds the just-created
// PIN only long enough to offer biometric enrollment once, right after a
// fresh signup completes (RequirePinNavigator's own BiometricSetup step is
// skipped for these users, since they already set a PIN during Registration
// — see AppNavigator's needsBiometricPrompt check). Cleared the moment that
// one-time prompt is shown, whether the user enables or declines.
const biometricPromptPinKey = (userId: string) => `biometric_prompt_signup_pin:${userId}`;

// Pre-scoping key name used before this fix. No longer written, but a stray
// value may still exist on devices that signed up under the old code — purged
// (never consumed) via purgeLegacyPendingPin() so it can't be inherited by
// whichever account happens to check next.
const LEGACY_PENDING_PIN_KEY = 'pending_signup_pin';

export interface PINVerifyResult {
  valid: boolean;
  locked: boolean;
  restricted?: boolean;
  lockedUntil?: string | null;
  attemptsRemaining?: number | null;
  error?: string;
  /**
   * Server-issued, short-lived proof this PIN check just happened. Purchase/
   * withdrawal Edge Functions require this — a valid session alone is not
   * enough to move money. Present only when valid is true.
   */
  token?: string;
}

export interface PINLockStatus {
  hasPin: boolean;
  locked: boolean;
  lockedUntil?: string | null;
  retryAfterSeconds: number;
  attemptsRemaining: number;
}

/**
 * Session restore/refresh is on the app's launch path, so it gets a tighter
 * bound than a transaction call: better to surface a retryable error quickly
 * than to hold the user on a blank security screen.
 */
const SESSION_RESTORE_TIMEOUT_MS = 8_000;

/**
 * Default bound for the PIN lock-status RPC, used by the transaction flow
 * where the user has already committed to an action and waiting is expected.
 * The app-access gate passes a shorter one — see APP_GATE_STATUS_TIMEOUT_MS.
 */
const PIN_STATUS_TIMEOUT_MS = 12_000;

/**
 * Bound for the same RPC when it runs on app open. The gate can fall back to
 * its local lock decision, so a slow network should cost a few seconds at
 * most rather than the full transaction-grade wait.
 */
export const APP_GATE_STATUS_TIMEOUT_MS = 4_000;

export const authService = {
  async sendOTP(phone: string): Promise<AuthResult> {
    try {
      const { error } = await supabase.auth.signInWithOtp({ phone });
      if (error) throw error;
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  },

  async verifyOTP(phone: string, token: string): Promise<AuthResult> {
    try {
      const { error } = await supabase.auth.verifyOtp({
        phone,
        token,
        type: 'sms',
      });
      if (error) throw error;
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  },

  /**
   * Forgot-password step 1: ask the server to email a 6-digit reset code.
   * Always resolves success for a well-formed email (the server never reveals
   * whether the account exists — anti-enumeration), so the UI can move to the
   * code screen unconditionally.
   */
  async requestPasswordReset(email: string): Promise<AuthResult & { message?: string }> {
    try {
      const { data, error } = await supabase.functions.invoke('send-password-reset', {
        body: { email: email.trim().toLowerCase() },
      });
      if (error && !data) throw error;
      if (data?.success === false) {
        return { success: false, error: data.error || 'Could not send a reset code. Please try again.' };
      }
      return { success: true, message: data?.message };
    } catch (error: any) {
      return { success: false, error: error.message || 'Network error. Please check your connection and try again.' };
    }
  },

  /**
   * Forgot-password step 2: verify the emailed code and set the new password.
   * The code is the only credential required (the user has no session).
   */
  async confirmPasswordReset(
    email: string,
    code: string,
    newPassword: string,
  ): Promise<AuthResult & { attemptsRemaining?: number | null }> {
    try {
      const passwordError = passwordValidationError(newPassword);
      if (passwordError) return { success: false, error: passwordError };
      const { data, error } = await supabase.functions.invoke('verify-password-reset', {
        body: { email: email.trim().toLowerCase(), code: code.trim(), newPassword },
      });
      if (error && !data) throw error;
      if (data?.success === false) {
        return { success: false, error: data.error || 'Could not reset your password.', attemptsRemaining: data.attempts_remaining };
      }
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message || 'Network error. Please check your connection and try again.' };
    }
  },

  /**
   * Step 1 of changing phone/email from Edit Profile: requires a fresh PIN/
   * biometric step-up token (from useTransactionAuth().authorize()). Adding
   * a phone when none is on file applies immediately (`applied: true`);
   * changing an existing phone, or any email, instead emails an OTP to the
   * account's current address and returns `applied: false` — the caller
   * should then collect the code and call confirmProfileChange.
   */
  async requestProfileChange(
    field: 'phone' | 'email',
    newValue: string,
    authToken: string,
  ): Promise<AuthResult & { applied?: boolean; sentTo?: string }> {
    try {
      const { data, error } = await supabase.functions.invoke('request-profile-change', {
        body: { field, new_value: newValue, auth_token: authToken },
      });
      if (error && !data) throw error;
      if (data?.success === false) {
        return { success: false, error: data.error || 'Could not start this change. Please try again.' };
      }
      return { success: true, applied: !!data?.applied, sentTo: data?.sent_to };
    } catch (error: any) {
      return { success: false, error: error.message || 'Network error. Please check your connection and try again.' };
    }
  },

  /** Step 2: verifies the emailed code and, on success, applies the change. */
  async confirmProfileChange(
    field: 'phone' | 'email',
    code: string,
  ): Promise<AuthResult & { newValue?: string; attemptsRemaining?: number | null }> {
    try {
      const { data, error } = await supabase.functions.invoke('confirm-profile-change', {
        body: { field, code: code.trim() },
      });
      if (error && !data) throw error;
      if (data?.success === false) {
        return {
          success: false,
          error: data.error || 'Could not verify code. Please try again.',
          attemptsRemaining: data.attempts_remaining,
        };
      }
      return { success: true, newValue: data?.new_value };
    } catch (error: any) {
      return { success: false, error: error.message || 'Network error. Please check your connection and try again.' };
    }
  },

  async signInWithEmail(email: string, password: string): Promise<AuthResult> {
    try {
      const { error } = await withTimeout(
        (async () => supabase.auth.signInWithPassword({ email, password }))(),
      );
      if (error) throw error;
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  },

  /**
   * Creates the account directly with email+password — no OTP step. Matches
   * signInWithEmail, which is what LoginScreen has always used, so a user
   * created here can actually log back in later (the old phone-OTP flow
   * never set a password, so returning users had no way to sign back in).
   * Returns `needsEmailConfirmation: true` if the Supabase project has
   * "Confirm email" enabled — in that case signUp() succeeds but doesn't
   * return a usable session, so the caller can't go straight into the app.
   */
  async signUpWithEmail(
    email: string,
    password: string,
    metadata: Record<string, unknown>,
  ): Promise<AuthResult & { needsEmailConfirmation?: boolean; userId?: string }> {
    try {
      const passwordError = passwordValidationError(password);
      if (passwordError) return { success: false, error: passwordError };
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: { data: metadata },
      });
      if (error) throw error;
      if (!data.session) {
        return { success: true, needsEmailConfirmation: true, userId: data.user?.id };
      }
      return { success: true, userId: data.session.user.id };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  },

  /**
   * Set the user's transaction PIN. The PIN is sent over TLS to the server,
   * which bcrypt-hashes it into a server-only table. It is NEVER stored in
   * plaintext (not in auth metadata, not on the device).
   */
  async savePIN(pin: string, authToken?: string): Promise<AuthResult> {
    try {
      if (!/^\d{4}$/.test(pin)) {
        return { success: false, error: 'PIN must be 4 digits' };
      }
      const { error } = await supabase.rpc('set_user_pin', {
        p_pin: pin,
        p_auth_token: authToken ?? null,
      });
      if (error) throw error;
      await storageHelpers.delete(StorageKeys.PIN_LOCKED_UNTIL);
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  },

  async requestPinReset(): Promise<{ success: boolean; sentTo?: string; error?: string }> {
    try {
      const { data, error } = await withTimeout(
        supabase.functions.invoke('request-pin-reset', { body: {} }),
        20_000,
      );
      if (error || !data?.success) {
        return { success: false, error: data?.error || 'Could not send the reset code.' };
      }
      return { success: true, sentTo: data.sent_to };
    } catch {
      return { success: false, error: 'Network error. Please try again.' };
    }
  },

  async confirmPinReset(code: string, newPin: string): Promise<AuthResult> {
    try {
      if (!/^\d{6}$/.test(code)) return { success: false, error: 'Enter the 6-digit code.' };
      if (!/^\d{4}$/.test(newPin)) return { success: false, error: 'PIN must be 4 digits.' };
      const { data, error } = await withTimeout(
        supabase.functions.invoke('confirm-pin-reset', {
          body: { code, new_pin: newPin },
        }),
        20_000,
      );
      if (error || !data?.success) {
        return { success: false, error: data?.error || 'Could not reset your PIN.' };
      }
      // The old PIN must never remain available through biometric storage.
      await authService.saveBiometric(false);
      return { success: true };
    } catch {
      return { success: false, error: 'Network error. Please try again.' };
    }
  },

  /**
   * Whether the caller already has a transaction PIN set. Throws (rather
   * than swallowing to `false`) when the check itself couldn't complete —
   * a network timeout is not the same fact as "no PIN exists", and every
   * caller here needs to tell those apart: collapsing them used to mean a
   * flaky connection could re-trigger the "Create your PIN" onboarding gate
   * for someone who'd already set one, every single time their network blipped.
   */
  async hasPIN(): Promise<boolean> {
    const { data, error } = await withTimeout((async () => supabase.rpc('has_user_pin'))());
    if (error) throw error;
    return !!data;
  },

  /**
   * Stash the PIN entered during signup so it can be persisted once the auth
   * session is fully established. Right after supabase.auth.signUp() the new
   * access token often isn't attached to RPC calls yet, so set_user_pin runs
   * unauthenticated and fails — which strands users on a redundant "Create PIN"
   * gate. Encrypted at rest (SecureStore / Keychain-Keystore). Keyed by the
   * new account's own user id — never a device-global key — so a different
   * account signing in later on the same device can't read it back.
   */
  async stashSignupPin(userId: string, pin: string): Promise<void> {
    try {
      if (userId && /^\d{4}$/.test(pin)) await SecureStore.setItemAsync(pendingPinKey(userId), pin);
    } catch {
      // best-effort — the immediate savePIN attempt may still succeed
    }
  },

  /**
   * Clears this account's stashed signup PIN, if any. Called right after an
   * immediate savePIN() succeeds (so a successfully-saved PIN never lingers
   * on the device) and on sign-out (defense in depth, in case the immediate
   * save never ran).
   */
  async clearStashedPin(userId: string): Promise<void> {
    if (!userId) return;
    try { await SecureStore.deleteItemAsync(pendingPinKey(userId)); } catch {}
  },

  /** Stashes the signup PIN for the one-time post-signup biometric prompt. */
  async stashPinForBiometricPrompt(userId: string, pin: string): Promise<void> {
    try {
      if (userId && /^\d{4}$/.test(pin)) await SecureStore.setItemAsync(biometricPromptPinKey(userId), pin);
    } catch {
      // best-effort — worst case, that prompt is simply skipped for this signup
    }
  },

  /** Reads back the stashed pin for the post-signup biometric prompt, if any. */
  async getStashedBiometricPromptPin(userId: string): Promise<string | null> {
    if (!userId) return null;
    try { return await SecureStore.getItemAsync(biometricPromptPinKey(userId)); } catch { return null; }
  },

  /** Clears the post-signup biometric prompt stash — called once that prompt has been shown, and on sign-out. */
  async clearStashedBiometricPromptPin(userId: string): Promise<void> {
    if (!userId) return;
    try { await SecureStore.deleteItemAsync(biometricPromptPinKey(userId)); } catch {}
  },

  /**
   * Best-effort one-time cleanup of the pre-scoping global stash key. Never
   * read/consumed — only deleted, since there's no safe way to know which
   * account it belonged to. Call unconditionally on app startup.
   */
  async purgeLegacyPendingPin(): Promise<void> {
    try { await SecureStore.deleteItemAsync(LEGACY_PENDING_PIN_KEY); } catch {}
  },

  /**
   * Ensures the account has a transaction PIN, saving one stashed at signup if
   * the immediate save didn't land. Meant to run once the session is fully
   * established (after email verification) — the same condition under which
   * PINSetupScreen's save reliably works. Returns whether a PIN now exists,
   * and clears the stash once saved so the PIN is never left on the device.
   * Only ever reads the CURRENT session's own stash entry.
   */
  async ensurePinSaved(): Promise<boolean> {
    try {
      const session = await authService.getCurrentSession();
      const userId = session?.user?.id;
      if (!userId) return false;

      if (await authService.hasPIN()) {
        await authService.clearStashedPin(userId);
        return true;
      }
      let pending: string | null = null;
      try { pending = await SecureStore.getItemAsync(pendingPinKey(userId)); } catch {}
      if (!pending) return false;
      const res = await authService.savePIN(pending);
      if (res.success) {
        await authService.clearStashedPin(userId);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  },

  /**
   * Verify the user's PIN server-side. Rate-limited with a lockout after
   * repeated failures. Use this to gate sensitive actions (payments, etc.).
   * On success, the server also issues a one-time step-up token (or a
   * multi-use one when `maxUses` > 1, for bulk-send flows) that must be
   * passed to the purchase/withdrawal Edge Function to actually move money.
   */
  async verifyPIN(pin: string, maxUses = 1): Promise<PINVerifyResult> {
    try {
      // Guards against a stalled network request (flaky mobile connection,
      // battery-saver throttling background network on some Android
      // skins, a stuck silent token refresh, etc.) leaving the caller stuck
      // on a spinner forever — there's no server-side timeout that helps if
      // the request never actually completes on the client's end.
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Network timeout. Please check your connection and try again.')), 20000),
      );
      const { data, error } = await Promise.race([
        supabase.rpc('verify_user_pin', { p_pin: pin, p_max_uses: maxUses }),
        timeout,
      ]);
      if (error) throw error;
      return {
        valid: !!data?.valid,
        locked: !!data?.locked,
        lockedUntil: data?.locked_until ?? null,
        attemptsRemaining: data?.attempts_remaining ?? null,
        restricted: data?.restricted === true,
        error: data?.error,
        token: data?.token,
      };
    } catch (error: any) {
      return { valid: false, locked: false, error: error.message };
    }
  },

  async getPINLockStatus(): Promise<PINLockStatus> {
    try {
      const { data, error } = await withTimeout(
        (async () => supabase.rpc('get_user_pin_lock_status'))(),
        PIN_STATUS_TIMEOUT_MS,
      );
      if (error) throw error;
      return {
        hasPin: data?.has_pin !== false,
        locked: !!data?.locked,
        lockedUntil: data?.locked_until ?? null,
        retryAfterSeconds: Math.max(0, Number(data?.retry_after_seconds) || 0),
        attemptsRemaining: Math.max(0, Number(data?.attempts_remaining) || 0),
      };
    } catch {
      // A status-check failure must not weaken or invent a lock. The PIN
      // verification RPC remains authoritative and will return the lock on
      // the next attempted verification.
      return { hasPin: true, locked: false, retryAfterSeconds: 0, attemptsRemaining: 0 };
    }
  },

  /**
   * Strict variant for the app-access gate. Unlike the transaction UX helper
   * above, a network failure is not converted into "unlocked" because doing
   * so would expose the signed-in app before security status is known.
   */
  async getPINLockStatusStrict(timeoutMs: number = PIN_STATUS_TIMEOUT_MS): Promise<PINLockStatus> {
    const { data, error } = await withTimeout(
      (async () => supabase.rpc('get_user_pin_lock_status'))(),
      timeoutMs,
    );
    if (error) throw error;
    return {
      hasPin: data?.has_pin !== false,
      locked: !!data?.locked,
      lockedUntil: data?.locked_until ?? null,
      retryAfterSeconds: Math.max(0, Number(data?.retry_after_seconds) || 0),
      attemptsRemaining: Math.max(0, Number(data?.attempts_remaining) || 0),
    };
  },

  async saveBiometric(enabled: boolean): Promise<void> {
    await supabase.auth.updateUser({
      data: { biometric_enabled: enabled },
    });
    await storageHelpers.setBoolean(StorageKeys.BIOMETRIC_ENABLED, enabled);
    if (!enabled) await authService.clearBiometricPin();
  },

  /** Whether the user has opted into biometric authorization on this device. */
  async isBiometricEnabled(): Promise<boolean> {
    return (await storageHelpers.getBoolean(StorageKeys.BIOMETRIC_ENABLED)) === true;
  },

  /**
   * Stores the PIN behind a biometric-gated hardware keychain entry
   * (iOS Keychain / Android Keystore, via SecureStore's
   * `requireAuthentication`). This is what lets Face ID/fingerprint
   * authorize a transaction: the device's OS — not this app — enforces the
   * biometric check before releasing the PIN, which is then sent through
   * the exact same server-side verify_user_pin check as manual entry. The
   * PIN itself never leaves the device except over TLS to that RPC.
   */
  async saveBiometricPin(pin: string): Promise<void> {
    await SecureStore.setItemAsync(StorageKeys.BIOMETRIC_PIN, pin, {
      requireAuthentication: true,
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
    // Plain, ungated flag so callers can check "is anything actually stored?"
    // without touching the gated entry itself (see hasBiometricPin below).
    await storageHelpers.setBoolean(StorageKeys.BIOMETRIC_PIN_SET, true);
  },

  /**
   * Cheap existence check — no biometric prompt, no keychain read. Accounts
   * that had `biometric_enabled` saved before this PIN-token system existed
   * never had anything written to BIOMETRIC_PIN, so callers must check this
   * BEFORE calling getBiometricPin(): reading a `requireAuthentication`
   * entry that was never written can hang on some devices instead of
   * cleanly rejecting, which is exactly what happened here.
   */
  async hasBiometricPin(): Promise<boolean> {
    return (await storageHelpers.getBoolean(StorageKeys.BIOMETRIC_PIN_SET)) === true;
  },

  /** Triggers the OS biometric prompt; resolves the stored PIN, or null if unavailable/declined/timed out. */
  async getBiometricPin(): Promise<string | null> {
    try {
      const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 15000));
      return await Promise.race([
        SecureStore.getItemAsync(StorageKeys.BIOMETRIC_PIN, {
          requireAuthentication: true,
          authenticationPrompt: 'Authorize transaction',
        }),
        timeout,
      ]);
    } catch {
      return null;
    }
  },

  async clearBiometricPin(): Promise<void> {
    try {
      await SecureStore.deleteItemAsync(StorageKeys.BIOMETRIC_PIN);
    } catch {
      // nothing stored — fine
    }
    await storageHelpers.setBoolean(StorageKeys.BIOMETRIC_PIN_SET, false);
  },

  /**
   * NOTE: getSession() is not purely local. When the stored access token has
   * expired — the normal case for a returning user, since RN suspends the
   * auto-refresh timer while backgrounded — supabase-js performs a network
   * token refresh inside this call. Unwrapped, that can hang indefinitely on
   * a stalled connection, which is exactly what left the app-access gate
   * stuck on "Checking security status…" with no error and no way out.
   */
  async getCurrentSession() {
    const { data: { session } } = await withTimeout(
      (async () => supabase.auth.getSession())(),
      SESSION_RESTORE_TIMEOUT_MS,
    );
    return session;
  },

  async signOut() {
    // Captured before signOut() tears down the session — this is the last
    // point the outgoing account's own id is available, to clear any
    // leftover stashed signup PIN before the device is handed to whoever
    // signs in next.
    let outgoingUserId: string | undefined;
    try {
      outgoingUserId = (await authService.getCurrentSession())?.user?.id;
    } catch {
      // best-effort — a failed lookup here shouldn't block sign-out
    }
    try {
      // 'local' scope clears the session on this device immediately without
      // first waiting on a network call to invalidate it server-side — the
      // default ('global') scope does that server call FIRST, so on a bad
      // or broken connection it can hang indefinitely and never get to
      // actually signing the user out locally. Revoking a specific device
      // remotely already has its own dedicated mechanism (Active Sessions'
      // device-session revocation, checked server-side on every sensitive
      // request) that doesn't depend on this call at all, so scoping this
      // one to 'local' doesn't weaken that.
      await supabase.auth.signOut({ scope: 'local' });
    } finally {
      if (outgoingUserId) {
        await authService.clearStashedPin(outgoingUserId);
        await authService.clearStashedBiometricPromptPin(outgoingUserId);
      }
      await storageHelpers.clearAll();
      clearAllCache();
    }
  },

  onAuthStateChange(callback: (session: any) => void) {
    return supabase.auth.onAuthStateChange((_event, session) => {
      callback(session);
    });
  },
};
