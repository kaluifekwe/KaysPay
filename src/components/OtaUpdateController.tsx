import React, { useEffect } from 'react';
import * as Updates from 'expo-updates';

const INITIAL_CHECK_DELAY_MS = 2_000;

/**
 * Checks once per app session for a compatible production OTA update.
 *
 * Downloads a compatible update in the background. It is never applied or
 * reloaded during the active session; Expo selects it on a later cold launch.
 * Failures remain non-blocking for customers on unreliable connections.
 */
export function OtaUpdateController() {
  useEffect(() => {
    if (__DEV__ || !Updates.isEnabled) return;

    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const result = await Updates.checkForUpdateAsync();
          if (!result.isAvailable || cancelled) return;

          await Updates.fetchUpdateAsync();
        } catch (error) {
          // OTA availability must never prevent access to a financial app.
          if (__DEV__) console.warn('OTA update check failed', error);
        }
      })();
    }, INITIAL_CHECK_DELAY_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  return null;
}
