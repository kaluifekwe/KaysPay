import { supabase } from '../lib/supabase';
import { StorageKeys, storageHelpers } from '../lib/mmkv';

// Owner-editable app settings, read from the app_settings table (migration
// 131) and changed from the admin Settings page. Previously the support
// WhatsApp number was hardcoded in three separate screens, so changing it
// needed a code change and an OTA ship.
//
// Deliberately a module-level cache rather than a React context: every
// place this is used reads it inside an onPress handler (opening WhatsApp),
// never during render, so nothing needs to re-render when it loads. That
// keeps this a plain async load with no provider plumbing.

// Build-time fallback. Support must be reachable even on a cold first launch
// with no network, so this is the current number at time of shipping — kept
// in sync with migration 131's seeded value. The server value always wins
// once loaded.
const FALLBACK_SUPPORT_WHATSAPP = '2349068446111';

let cachedWhatsAppNumber: string | null = null;

/**
 * The support WhatsApp number in the digits-only international form wa.me
 * expects. Synchronous by design (see the note above) — returns the loaded
 * server value, else the last persisted one, else the build-time fallback,
 * so it is never empty and Contact Support can never become a dead button.
 */
export function supportWhatsAppNumber(): string {
  return cachedWhatsAppNumber || FALLBACK_SUPPORT_WHATSAPP;
}

/** `https://wa.me/<number>` — works whether or not WhatsApp is installed. */
export function supportWhatsAppUrl(): string {
  return `https://wa.me/${supportWhatsAppNumber()}`;
}

/**
 * Loads settings from the server, falling back to the last persisted value
 * while offline. Safe to call more than once; called on app start (App.tsx).
 * Never throws — a settings read failing must never block app startup.
 */
export async function loadAppSettings(): Promise<void> {
  // Seed from storage first so an offline launch still gets the most recent
  // known-good number rather than the build-time default.
  if (!cachedWhatsAppNumber) {
    const stored = await storageHelpers.getString(StorageKeys.SUPPORT_WHATSAPP_NUMBER);
    if (stored) cachedWhatsAppNumber = stored;
  }

  try {
    const { data, error } = await supabase
      .from('app_settings')
      .select('key, value')
      .eq('key', 'support_whatsapp_number')
      .maybeSingle();
    if (error || !data?.value) return;

    const value = String(data.value).replace(/[^\d]/g, '');
    if (value.length < 10 || value.length > 15) return; // ignore a malformed row
    if (value === cachedWhatsAppNumber) return;

    cachedWhatsAppNumber = value;
    await storageHelpers.setString(StorageKeys.SUPPORT_WHATSAPP_NUMBER, value);
  } catch {
    // Offline or transient — the cached/fallback number stays in use.
  }
}
