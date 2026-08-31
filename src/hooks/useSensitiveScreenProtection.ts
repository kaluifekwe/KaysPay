import { useEffect } from 'react';
import * as ScreenCapture from 'expo-screen-capture';

/**
 * Blocks screenshots/recording only while a sensitive screen (or the
 * sensitive part of one) is mounted. `enabled` defaults to true for the
 * common case of a whole screen being sensitive; pass a condition (e.g.
 * a multi-step form's current step) to scope protection to only the
 * part that actually shows a password/PIN, leaving the rest of the flow
 * screenshottable.
 */
export function useSensitiveScreenProtection(enabled: boolean = true): void {
  useEffect(() => {
    if (!enabled) return;
    const key = `kayspay-sensitive-${Date.now()}-${Math.random()}`;
    void ScreenCapture.preventScreenCaptureAsync(key);
    return () => {
      void ScreenCapture.allowScreenCaptureAsync(key);
    };
  }, [enabled]);
}
