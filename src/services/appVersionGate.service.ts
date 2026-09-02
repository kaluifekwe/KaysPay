import * as Application from 'expo-application';
import { Platform } from 'react-native';
import { supabase } from '../lib/supabase';
import { withTimeout } from '../utils/network';

export interface VersionGateResult {
  configured: boolean;
  needsUpdate: boolean;
  required: boolean;
  message: string;
  storeUrl: string;
  minVersion: string;
}

const NOT_CONFIGURED: VersionGateResult = {
  configured: false,
  needsUpdate: false,
  required: false,
  message: '',
  storeUrl: '',
  minVersion: '',
};

/**
 * Compares the installed native build against the server's minimum for this
 * platform. The comparison itself happens here, client-side, against a
 * server-supplied number -- there's nothing to defend against by moving it
 * server-side (self-reporting your own installed build isn't a way to
 * defraud anyone), and doing it here means the check works even mid-flight
 * with no round trip needed once the config is fetched.
 *
 * Fails open on every error path: a missing config row, a network failure,
 * or a platform this isn't wired for (only Android is seeded so far) all
 * resolve to "no update needed" rather than risk blocking access to a
 * financial app over a broken check.
 */
export async function checkAppVersionGate(): Promise<VersionGateResult> {
  if (Platform.OS !== 'android' && Platform.OS !== 'ios') return NOT_CONFIGURED;
  try {
    const installedBuild = Number(Application.nativeBuildVersion);
    if (!Number.isFinite(installedBuild)) return NOT_CONFIGURED;

    const { data, error } = await withTimeout(
      Promise.resolve(
        supabase
          .from('app_version_gate')
          .select('min_build_number, min_version, required, message, store_url')
          .eq('platform', Platform.OS)
          .maybeSingle(),
      ),
      8000,
    );
    if (error || !data) return NOT_CONFIGURED;

    const minBuild = Number(data.min_build_number);
    if (!Number.isFinite(minBuild)) return NOT_CONFIGURED;

    return {
      configured: true,
      needsUpdate: installedBuild < minBuild,
      required: data.required === true,
      message: typeof data.message === 'string' ? data.message : 'A new version of KaysPay is available.',
      storeUrl: typeof data.store_url === 'string' ? data.store_url : '',
      minVersion: typeof data.min_version === 'string' ? data.min_version : '',
    };
  } catch {
    return NOT_CONFIGURED; // never blocks access over a check that itself failed
  }
}
