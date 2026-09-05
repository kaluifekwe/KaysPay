import { useCallback } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import * as ScreenCapture from 'expo-screen-capture';

/**
 * Blocks screenshots/recording only while a sensitive screen (or the
 * sensitive part of one) is FOCUSED -- not merely mounted. `enabled`
 * defaults to true for the common case of a whole screen being sensitive;
 * pass a condition (e.g. a multi-step form's current step) to scope
 * protection to only the part that actually shows a password/PIN, leaving
 * the rest of the flow screenshottable.
 *
 * Tied to focus (useFocusEffect), not mount, because a stack navigator
 * screen stays mounted underneath whatever gets pushed on top of it --
 * Android's screenshot block is a device-wide flag, not scoped to
 * whichever screen is visually on top. A plain useEffect here would only
 * release the block on unmount, so navigating from a protected screen
 * onward (without popping back past it first) left screenshots silently
 * blocked on every screen after it, including totally unrelated ones. A
 * real report traced to exactly this: Crypto has no protection of its own
 * at all, but a leftover mounted-underneath protected screen kept
 * blocking screenshots there anyway. 2026-09-05.
 */
export function useSensitiveScreenProtection(enabled: boolean = true): void {
  useFocusEffect(
    useCallback(() => {
      if (!enabled) return;
      const key = `kayspay-sensitive-${Date.now()}-${Math.random()}`;
      void ScreenCapture.preventScreenCaptureAsync(key);
      return () => {
        void ScreenCapture.allowScreenCaptureAsync(key);
      };
    }, [enabled]),
  );
}
