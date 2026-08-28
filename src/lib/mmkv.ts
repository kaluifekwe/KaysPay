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
};

// Helper functions using SecureStore (max 2KB per item)
export const storageHelpers = {
  getString: async (key: string): Promise<string | undefined> => {
    try {
      return (await SecureStore.getItemAsync(key)) ?? undefined;
    } catch {
      return undefined;
    }
  },

  setString: async (key: string, value: string): Promise<void> => {
    try {
      await SecureStore.setItemAsync(key, value);
    } catch (error) {
      console.error('Failed to store string:', error);
    }
  },

  getNumber: async (key: string): Promise<number | undefined> => {
    try {
      const value = await SecureStore.getItemAsync(key);
      return value ? Number(value) : undefined;
    } catch {
      return undefined;
    }
  },

  setNumber: async (key: string, value: number): Promise<void> => {
    try {
      await SecureStore.setItemAsync(key, String(value));
    } catch (error) {
      console.error('Failed to store number:', error);
    }
  },

  getBoolean: async (key: string): Promise<boolean | undefined> => {
    try {
      const value = await SecureStore.getItemAsync(key);
      if (value === null || value === undefined) return undefined;
      return value === 'true';
    } catch {
      return undefined;
    }
  },

  setBoolean: async (key: string, value: boolean): Promise<void> => {
    try {
      await SecureStore.setItemAsync(key, String(value));
    } catch (error) {
      console.error('Failed to store boolean:', error);
    }
  },

  getObject: async <T>(key: string): Promise<T | undefined> => {
    try {
      const json = await SecureStore.getItemAsync(key);
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
      await SecureStore.setItemAsync(key, json);
    } catch (error) {
      console.error('Failed to store object:', error);
    }
  },

  delete: async (key: string): Promise<void> => {
    try {
      await SecureStore.deleteItemAsync(key);
    } catch (error) {
      console.error('Failed to delete:', error);
    }
  },

  clearAll: async (): Promise<void> => {
    try {
      // SecureStore doesn't have clearAll, we delete keys individually
      const allKeys = Object.values(StorageKeys);
      for (const key of allKeys) {
        await SecureStore.deleteItemAsync(key).catch(() => {});
      }
    } catch (error) {
      console.error('Failed to clear storage:', error);
    }
  },
};
