import React, { useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';
import * as Updates from 'expo-updates';
import { useTransactionAuth } from './TransactionAuthProvider';

const INITIAL_CHECK_DELAY_MS = 2_000;

/**
 * Checks once per app session for a compatible production OTA update.
 *
 * Download failures are intentionally non-blocking: customers on slow or
 * unavailable networks can continue using the embedded app. Applying an
 * update always requires an explicit tap, so the app never reloads itself in
 * the middle of a financial action.
 */
export function OtaUpdateController() {
  const { isAuthorizing } = useTransactionAuth();
  const [updateDownloaded, setUpdateDownloaded] = useState(false);
  const promptShownRef = useRef(false);

  useEffect(() => {
    if (__DEV__ || !Updates.isEnabled) return;

    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const result = await Updates.checkForUpdateAsync();
          if (!result.isAvailable || cancelled) return;

          const fetched = await Updates.fetchUpdateAsync();
          if (!cancelled && fetched.isNew) setUpdateDownloaded(true);
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

  useEffect(() => {
    if (!updateDownloaded || isAuthorizing || promptShownRef.current) return;
    promptShownRef.current = true;

    Alert.alert(
      'Update ready',
      'A new KaysPay update has been downloaded. Restart the app now to apply it.',
      [
        { text: 'Later', style: 'cancel' },
        {
          text: 'Restart now',
          onPress: () => {
            void Updates.reloadAsync().catch(() => {
              Alert.alert(
                'Restart required',
                'Please close and reopen KaysPay to finish applying the update.',
              );
            });
          },
        },
      ],
      { cancelable: true },
    );
  }, [isAuthorizing, updateDownloaded]);

  return null;
}
