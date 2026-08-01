import * as SecureStore from 'expo-secure-store';
import * as Device from 'expo-device';
import { Platform } from 'react-native';
import { supabase } from '../lib/supabase';

const DEVICE_ID_KEY = 'kayspay_device_id';
async function deviceId(): Promise<string> {
  const existing = await SecureStore.getItemAsync(DEVICE_ID_KEY);
  if (existing) return existing;
  const created = `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  await SecureStore.setItemAsync(DEVICE_ID_KEY, created, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
  return created;
}
async function invoke(body: Record<string, unknown>) {
  const { data, error } = await supabase.functions.invoke('device-sessions', { body });
  if (error && !data) throw error;
  return data;
}

export type DeviceSession = { id: string; device_name: string; platform: string; last_active_at: string; created_at: string; revoked_at: string | null; is_current: boolean };

export const deviceSessionService = {
  async register() {
    return invoke({ action: 'register', device_id: await deviceId(), device_name: Device.modelName || `${Platform.OS} device`, platform: Platform.OS });
  },
  async list(): Promise<DeviceSession[]> { return (await invoke({ action: 'list' }))?.sessions ?? []; },
  async revoke(id: string): Promise<boolean> { return (await invoke({ action: 'revoke', id }))?.success === true; },
  async revokeOthers(): Promise<number> { return Number((await invoke({ action: 'revoke_others' }))?.count ?? 0); },
  async notifyPinChanged(): Promise<void> { await invoke({ action: 'pin_changed' }); },
  async isRevoked(): Promise<boolean> {
    try { return (await invoke({ action: 'check' }))?.revoked === true; } catch { return false; }
  },
};
