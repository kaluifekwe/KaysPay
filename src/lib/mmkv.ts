import * as SecureStore from 'expo-secure-store';

// Storage keys
export const StorageKeys = {
  CONTACT_INDEX: 'contact_index',
  CONTACT_INDEX_UPDATED: 'contact_index_updated',
  BALANCE_VISIBLE: 'balance_visible',
  QUICK_ACTIONS_ORDER: 'quick_actions_order',
  FAVOURITE_CONTACTS: 'favourite_contacts',
  USER_PIN_HASH: 'user_pin_hash',
  BIOMETRIC_ENABLED: 'biometric_enabled',
  BIOMETRIC_PIN: 'biometric_pin',
  // Cheap, non-gated existence flag for BIOMETRIC_PIN — lets the app check
  // "is there actually something to read?" without touching the
  // biometric-gated keychain entry itself (that read can hang/misbehave on
  // some devices when the underlying key doesn't exist yet).
  BIOMETRIC_PIN_SET: 'biometric_pin_set',
  ONBOARDING_COMPLETED: 'onboarding_completed',
  // Random analytics identity only — no hardware/device fingerprint and no PII.
  ANALYTICS_INSTALLATION_ID: 'analytics_installation_id',
  LAST_CONTACT_REFRESH: 'last_contact_refresh',
  // Android Storage Access Framework directory URI the user picked once for
  // "Download PDF" — reused on every later download so the folder picker
  // only ever appears the first time.
  DOWNLOAD_FOLDER_URI: 'download_folder_uri',
  // App-access security state. These are encrypted by SecureStore; the
  // server remains authoritative for the PIN lock deadline.
  PRIVACY_BACKGROUNDED_AT: 'privacy_backgrounded_at',
  PIN_LOCKED_UNTIL: 'pin_locked_until',
  // Written every ~60s while the app is foregrounded (see AppPrivacyGate's
  // heartbeat) — "still active as of this moment", as a backup for
  // PRIVACY_BACKGROUNDED_AT. That write fires unawaited at the exact instant
  // the app backgrounds, which is also the moment Android is likeliest to
  // kill the process to reclaim memory; if it does, the write is lost and
  // the away-lock has nothing to compare against on the next open, no matter
  // how long the phone actually sat backgrounded. This heartbeat is never
  // more than a minute stale, so it can't have the same failure mode.
  LAST_ACTIVE_AT: 'last_active_at',
  // 'light' | 'dark' — see src/components/ThemeProvider.tsx.
  THEME_MODE: 'theme_mode',
  // Last known server value for the support WhatsApp number, so Contact
  // Support still reaches the CURRENT number when offline rather than
  // falling back to the build-time default — see appSettings.service.ts.
  SUPPORT_WHATSAPP_NUMBER: 'support_whatsapp_number',
  // Last known Crypto screen balances/rates, painted instantly on open while
  // the real live numbers load in the background — see CryptoScreen.tsx.
  // Display-only: every actual Buy/Sell/Withdraw re-checks the live balance
  // server-side regardless of what this cache holds.
  CRYPTO_SCREEN_CACHE: 'crypto_screen_cache',
  // Set the first time this device ever sees a completed purchase — see
  // analytics.service.ts's trackFirstPurchaseIfNeeded(). Deliberately
  // persisted rather than an in-memory ref (like first_funding_completed
  // uses): "first" needs to survive the app being closed and reopened, not
  // just the current screen staying mounted.
  HAS_COMPLETED_FIRST_PURCHASE: 'has_completed_first_purchase',
  // How many biometric attempts in a row have failed to produce a valid PIN
  // — see TransactionAuthProvider.tryBiometric. A single failure is treated
  // as an ordinary cancel/decline and stays silent, same as before; only a
  // second one in a row (which a stale or invalidated keychain entry
  // produces every single time, forever, with no way for the app to detect
  // that on its own) surfaces a message telling the customer biometric needs
  // re-enabling. Reset to 0 the moment biometric succeeds.
  BIOMETRIC_CONSECUTIVE_FAILURES: 'biometric_consecutive_failures',
};

// SecureStore validates every key against /^[\w.-]+$/ and THROWS on anything
// else — so a key built from a dynamic value (an email, a user id joined with
// ':') rejects every read and write. Because each helper below catches and
// returns undefined, that failure is completely silent: the value simply never
// stores, and reads forever answer "nothing here".
//
// Three onboarding keys were built that way, and none had ever stored a single
// value on any device:
//   email_otp_last_sent_at:<email>   -> the email OTP resend cooldown never
//                                       applied, so every remount of the
//                                       verification screen sent a NEW code
//                                       and silently invalidated the one
//                                       already in the customer's inbox.
//   pending_signup_pin:<userId>      -> the fallback that re-saves a signup
//                                       PIN when the first attempt fails.
//   biometric_prompt_signup_pin:<..> -> the one-time post-signup biometric
//                                       offer, which therefore never appeared.
//
// Sanitizing here rather than at each call site means a dynamic key cannot
// reintroduce this. Any already-valid key maps to itself, so nothing that
// currently works changes, and nothing needs migrating: the broken keys never
// held a value to migrate.
function safeKey(key: string): string {
  return key.replace(/[^\w.-]/g, '_');
}

// Helper functions using SecureStore (max 2KB per item)
export const storageHelpers = {
  getString: async (key: string): Promise<string | undefined> => {
    try {
      return (await SecureStore.getItemAsync(safeKey(key))) ?? undefined;
    } catch {
      return undefined;
    }
  },

  setString: async (key: string, value: string): Promise<void> => {
    try {
      await SecureStore.setItemAsync(safeKey(key), value);
    } catch (error) {
      console.error('Failed to store string:', error);
    }
  },

  getNumber: async (key: string): Promise<number | undefined> => {
    try {
      const value = await SecureStore.getItemAsync(safeKey(key));
      return value ? Number(value) : undefined;
    } catch {
      return undefined;
    }
  },

  setNumber: async (key: string, value: number): Promise<void> => {
    try {
      await SecureStore.setItemAsync(safeKey(key), String(value));
    } catch (error) {
      console.error('Failed to store number:', error);
    }
  },

  getBoolean: async (key: string): Promise<boolean | undefined> => {
    try {
      const value = await SecureStore.getItemAsync(safeKey(key));
      if (value === null || value === undefined) return undefined;
      return value === 'true';
    } catch {
      return undefined;
    }
  },

  setBoolean: async (key: string, value: boolean): Promise<void> => {
    try {
      await SecureStore.setItemAsync(safeKey(key), String(value));
    } catch (error) {
      console.error('Failed to store boolean:', error);
    }
  },

  getObject: async <T>(key: string): Promise<T | undefined> => {
    try {
      const json = await SecureStore.getItemAsync(safeKey(key));
      return json ? JSON.parse(json) : undefined;
    } catch {
      return undefined;
    }
  },

  setObject: async <T>(key: string, value: T): Promise<void> => {
    try {
      const json = JSON.stringify(value);
      if (json.length > 2000) {
        console.warn('Object too large for SecureStore, skipping:', key);
        return;
      }
      await SecureStore.setItemAsync(safeKey(key), json);
    } catch (error) {
      console.error('Failed to store object:', error);
    }
  },

  delete: async (key: string): Promise<void> => {
    try {
      await SecureStore.deleteItemAsync(safeKey(key));
    } catch (error) {
      console.error('Failed to delete:', error);
    }
  },

  clearAll: async (): Promise<void> => {
    try {
      // SecureStore doesn't have clearAll, we delete keys individually
      const allKeys = Object.values(StorageKeys);
      for (const key of allKeys) {
        await SecureStore.deleteItemAsync(safeKey(key)).catch(() => {});
      }
    } catch (error) {
      console.error('Failed to clear storage:', error);
    }
  },
};
