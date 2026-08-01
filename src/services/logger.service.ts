import { supabase } from '../lib/supabase';
import * as Device from 'expo-device';
import { Platform } from 'react-native';

export type ServiceType = 'airtime' | 'data' | 'bill' | 'exam_pin' | 'tv' | 'wallet_fund' | 'foreign_number' | 'dollar_card';
export type LogAction = 'view' | 'attempt' | 'success' | 'failure';
export type Provider = 'mtn' | 'airtel' | 'glo' | '9mobile' | 'ikeja-electric' | 'eko-electric' | 'dstv' | 'startimes' | 'gotv' | 'waec' | 'jamb' | 'neco' | 'paystack' | null;

interface LogEntry {
  service_type: ServiceType;
  provider?: Provider;
  action: LogAction;
  metadata?: Record<string, unknown>;
}

let deviceInfo: string | null = null;

function getDeviceInfo(): string {
  if (deviceInfo) return deviceInfo;
  deviceInfo = `${Platform.OS}/${Platform.Version}/${Device.modelName || 'unknown'}`;
  return deviceInfo;
}

export const logger = {
  async log(entry: LogEntry) {
    try {
      const { data: { user } } = await supabase.auth.getUser();

      if (!user) return;

      await supabase.rpc('log_service_event', {
        p_service_type: entry.service_type,
        p_provider: entry.provider || null,
        p_action: entry.action,
        p_metadata: entry.metadata || null,
        p_device_info: getDeviceInfo(),
      });
    } catch (error) {
      console.error('Failed to log service event:', error);
    }
  },

  async logView(service: ServiceType, provider?: Provider) {
    return this.log({ service_type: service, provider, action: 'view' });
  },

  async logAttempt(service: ServiceType, provider: Provider, metadata?: Record<string, unknown>) {
    return this.log({ service_type: service, provider, action: 'attempt', metadata });
  },

  async logSuccess(service: ServiceType, provider: Provider, metadata?: Record<string, unknown>) {
    return this.log({ service_type: service, provider, action: 'success', metadata });
  },

  async logFailure(service: ServiceType, provider: Provider, metadata?: Record<string, unknown>) {
    return this.log({ service_type: service, provider, action: 'failure', metadata });
  },

  async getServiceStats(serviceType: ServiceType) {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return { attempts: 0, successes: 0, failures: 0 };

      const { data } = await supabase
        .from('service_logs')
        .select('action')
        .eq('user_id', user.id)
        .eq('service_type', serviceType);

      const attempts = data?.filter((l) => l.action === 'attempt').length || 0;
      const successes = data?.filter((l) => l.action === 'success').length || 0;
      const failures = data?.filter((l) => l.action === 'failure').length || 0;

      return { attempts, successes, failures };
    } catch {
      return { attempts: 0, successes: 0, failures: 0 };
    }
  },

  async getProviderStats() {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return [];

      const { data } = await supabase
        .from('service_logs')
        .select('provider, action')
        .eq('user_id', user.id)
        .eq('action', 'success');

      const counts: Record<string, number> = {};
      data?.forEach((l) => {
        if (l.provider) {
          counts[l.provider] = (counts[l.provider] || 0) + 1;
        }
      });

      return Object.entries(counts)
        .map(([provider, count]) => ({ provider, count }))
        .sort((a, b) => b.count - a.count);
    } catch {
      return [];
    }
  },
};
