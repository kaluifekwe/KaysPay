import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import * as Device from 'expo-device';

export interface DeviceSecurityStatus {
  isRooted: boolean;
  isJailbroken: boolean;
  riskLevel: 'low' | 'medium' | 'high';
  deviceModel?: string;
  osVersion?: string;
}

/**
 * Best-effort device security check.
 *
 * LIMITATIONS:
 * - Pure JS cannot access filesystem paths outside the app sandbox.
 * - Cannot query installed packages or system properties.
 * - Cannot detect Magisk hiding, systemless root, or advanced jailbreaks.
 *
 * For production-grade detection, integrate a native module such as:
 * - react-native-root-detection (Android)
 * - react-native-jailbreak-detection (iOS)
 *
 * This hook provides the interface and basic heuristics; expand
 * `checkAndroidRoot` / `checkIOSJailbreak` when native modules are added.
 */
export function useDeviceSecurity(): DeviceSecurityStatus {
  const [status, setStatus] = useState<DeviceSecurityStatus>({
    isRooted: false,
    isJailbroken: false,
    riskLevel: 'low',
    deviceModel: Device.modelName || undefined,
    osVersion: Device.osVersion || undefined,
  });

  useEffect(() => {
    let cancelled = false;

    async function check() {
      if (cancelled) return;

      // These are intentionally best-effort. A failed or inconclusive
      // check is treated as "unknown" rather than "compromised" to avoid
      // false positives that would lock out legitimate users.
      let isRooted = false;
      let isJailbroken = false;

      if (Platform.OS === 'android') {
        isRooted = await checkAndroidRoot();
      } else if (Platform.OS === 'ios') {
        isJailbroken = await checkIOSJailbreak();
      }

      if (cancelled) return;

      const riskLevel = (isRooted || isJailbroken) ? 'high' : 'low';
      setStatus({
        isRooted,
        isJailbroken,
        riskLevel,
        deviceModel: Device.modelName || undefined,
        osVersion: Device.osVersion || undefined,
      });
    }

    check();
    return () => {
      cancelled = true;
    };
  }, []);

  return status;
}

/**
 * Android root detection heuristics.
 * NOTE: Real detection requires a native module to access:
 * - /system/bin/su, /system/xbin/su binaries
 * - com.topjohnwu.magisk, eu.chainfire.supersu packages
 * - ro.debuggable, ro.secure system properties
 */
async function checkAndroidRoot(): Promise<boolean> {
  // Placeholder: always returns false until a native module is integrated.
  // A native module would check for su binary, root apps, and system properties.
  return false;
}

/**
 * iOS jailbreak detection heuristics.
 * NOTE: Real detection requires a native module to access:
 * - /Applications/Cydia.app
 * - /usr/sbin/sshd
 * - MobileSubstrate.dylib
 * - Sandbox escape attempts
 */
async function checkIOSJailbreak(): Promise<boolean> {
  // Placeholder: always returns false until a native module is integrated.
  return false;
}
