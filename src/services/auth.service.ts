import * as SecureStore from 'expo-secure-store';
import { supabase } from '../lib/supabase';
import { storageHelpers, StorageKeys } from '../lib/mmkv';

export interface AuthResult {
  success: boolean;
  error?: string;
}

export interface PINVerifyResult {
  valid: boolean;
  locked: boolean;
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

  async signInWithEmail(email: string, password: string): Promise<AuthResult> {
    try {
      const { error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
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
  ): Promise<AuthResult & { needsEmailConfirmation?: boolean }> {
    try {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: { data: metadata },
      });
      if (error) throw error;
      if (!data.session) {
        return { success: true, needsEmailConfirmation: true };
      }
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  },

  /**
   * Set the user's transaction PIN. The PIN is sent over TLS to the server,
   * which bcrypt-hashes it into a server-only table. It is NEVER stored in
   * plaintext (not in auth metadata, not on the device).
   */
  async savePIN(pin: string): Promise<AuthResult> {
    try {
      if (!/^\d{4}$/.test(pin)) {
        return { success: false, error: 'PIN must be 4 digits' };
      }
      const { error } = await supabase.rpc('set_user_pin', { p_pin: pin });
      if (error) throw error;
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  },

  /** Whether the caller already has a transaction PIN set. */
  async hasPIN(): Promise<boolean> {
    try {
      const { data, error } = await supabase.rpc('has_user_pin');
      if (error) return false;
      return !!data;
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
        error: data?.error,
        token: data?.token,
      };
    } catch (error: any) {
      return { valid: false, locked: false, error: error.message };
    }
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

  async getCurrentSession() {
    const { data: { session } } = await supabase.auth.getSession();
    return session;
  },

  async signOut() {
    await supabase.auth.signOut();
    await storageHelpers.clearAll();
  },

  onAuthStateChange(callback: (session: any) => void) {
    return supabase.auth.onAuthStateChange((_event, session) => {
      callback(session);
    });
  },
};
