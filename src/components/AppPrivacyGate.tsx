import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, AppStateStatus, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors } from '../constants/colors';
import { useTransactionAuth } from './TransactionAuthProvider';
import { deviceSessionService } from '../services/deviceSession.service';
import { authService } from '../services/auth.service';
import { supabase } from '../lib/supabase';
import { storageHelpers, StorageKeys } from '../lib/mmkv';

const LOCK_AFTER_MS = 60 * 60 * 1000;

export function AppPrivacyGate({ children }: { children: React.ReactNode }) {
  const { authorize } = useTransactionAuth();
  const backgroundedAt = useRef<number | null>(null);
  const unlocking = useRef(false);
  const checkingRef = useRef(false);
  const [locked, setLocked] = useState(false);
  const [checkingSecurity, setCheckingSecurity] = useState(true);
  const [securityError, setSecurityError] = useState<string | null>(null);

  const checkSecurity = useCallback(async () => {
    if (checkingRef.current) return;
    checkingRef.current = true;
    setCheckingSecurity(true);
    setSecurityError(null);
    try {
      const session = await authService.getCurrentSession();
      if (!session) {
        setLocked(false);
        await Promise.all([
          storageHelpers.delete(StorageKeys.PRIVACY_BACKGROUNDED_AT),
          storageHelpers.delete(StorageKeys.PIN_LOCKED_UNTIL),
        ]);
        return;
      }

      const [status, storedBackgroundedAt] = await Promise.all([
        authService.getPINLockStatusStrict(),
        storageHelpers.getNumber(StorageKeys.PRIVACY_BACKGROUNDED_AT),
      ]);

      if (status.locked) {
        const serverLockedUntil = status.lockedUntil
          ? new Date(status.lockedUntil).getTime()
          : Date.now() + status.retryAfterSeconds * 1000;
        if (Number.isFinite(serverLockedUntil) && serverLockedUntil > Date.now()) {
          await storageHelpers.setNumber(StorageKeys.PIN_LOCKED_UNTIL, serverLockedUntil);
        }
        setLocked(true);
        return;
      }

      await storageHelpers.delete(StorageKeys.PIN_LOCKED_UNTIL);
      const wasAwayTooLong = typeof storedBackgroundedAt === 'number' &&
        Date.now() - storedBackgroundedAt >= LOCK_AFTER_MS;
      setLocked(wasAwayTooLong);
      if (!wasAwayTooLong) await storageHelpers.delete(StorageKeys.PRIVACY_BACKGROUNDED_AT);
    } catch {
      setLocked(true);
      setSecurityError('Unable to confirm your security status. Check your connection and try again.');
    } finally {
      checkingRef.current = false;
      setCheckingSecurity(false);
    }
  }, []);

  const unlock = useCallback(async () => {
    if (!locked || unlocking.current) return;
    unlocking.current = true;
    try {
      const result = await authorize({
        title: 'Unlock Kay’s Pay',
        subtitle: 'Confirm your PIN or biometric to continue',
      });
      if (result) {
        await Promise.all([
          storageHelpers.delete(StorageKeys.PRIVACY_BACKGROUNDED_AT),
          storageHelpers.delete(StorageKeys.PIN_LOCKED_UNTIL),
        ]);
        setSecurityError(null);
        setLocked(false);
      }
    } finally {
      unlocking.current = false;
    }
  }, [authorize, locked]);

  useEffect(() => {
    void checkSecurity();
  }, [checkSecurity]);

  useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_IN') {
        // Run after Supabase finishes publishing the restored/new session.
        setTimeout(() => { void checkSecurity(); }, 0);
      } else if (event === 'SIGNED_OUT') {
        setLocked(false);
        setSecurityError(null);
        setCheckingSecurity(false);
      }
    });
    return () => data.subscription.unsubscribe();
  }, [checkSecurity]);

  useEffect(() => {
    // React Native suspends JS timers while backgrounded, which is exactly
    // what Supabase's auto session-refresh relies on — without explicitly
    // pausing/resuming it around backgrounding (Supabase's own documented
    // requirement for RN), a session left backgrounded longer than the
    // ~1hr access-token lifetime comes back with no valid token and no
    // refresh in flight, landing the user on the login screen despite
    // nothing actually being wrong with their account.
    supabase.auth.startAutoRefresh();

    const onStateChange = (next: AppStateStatus) => {
      if (next !== 'active') {
        if (backgroundedAt.current === null) {
          backgroundedAt.current = Date.now();
          void storageHelpers.setNumber(
            StorageKeys.PRIVACY_BACKGROUNDED_AT,
            backgroundedAt.current,
          );
        }
        supabase.auth.stopAutoRefresh();
        return;
      }

      supabase.auth.startAutoRefresh();

      backgroundedAt.current = null;
      void checkSecurity();
      void deviceSessionService.isRevoked().then((revoked) => {
        if (revoked) void authService.signOut();
      });
    };

    const change = AppState.addEventListener('change', onStateChange);
    return () => {
      change.remove();
      supabase.auth.stopAutoRefresh();
    };
  }, [checkSecurity]);

  useEffect(() => {
    if (locked && !checkingSecurity && !securityError) void unlock();
  }, [checkingSecurity, locked, securityError, unlock]);

  return (
    <View style={styles.root}>
      {children}
      {(checkingSecurity || locked || securityError) && (
        <View style={styles.cover} accessibilityViewIsModal>
          <Ionicons name="shield-checkmark" size={52} color={Colors.GREEN} />
          <Text style={styles.title}>Kay’s Pay is protected</Text>
          {checkingSecurity ? (
            <View style={styles.checkingRow}>
              <ActivityIndicator color={Colors.GREEN} />
              <Text style={styles.message}>Checking security status…</Text>
            </View>
          ) : securityError ? (
            <>
              <Text style={styles.message}>{securityError}</Text>
              <TouchableOpacity style={styles.button} onPress={checkSecurity} activeOpacity={0.8}>
                <Text style={styles.buttonText}>Retry</Text>
              </TouchableOpacity>
            </>
          ) : (
            <TouchableOpacity style={styles.button} onPress={unlock} activeOpacity={0.8}>
              <Text style={styles.buttonText}>Unlock</Text>
            </TouchableOpacity>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  cover: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 1000,
    elevation: 1000,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.WHITE,
    padding: 24,
  },
  title: { marginTop: 14, fontSize: 20, fontWeight: '700', color: Colors.DARK },
  checkingRow: { marginTop: 20, alignItems: 'center', gap: 10 },
  message: { marginTop: 16, maxWidth: 300, textAlign: 'center', color: Colors.GRAY, fontSize: 14, lineHeight: 20 },
  button: {
    marginTop: 24,
    minWidth: 160,
    minHeight: 48,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.GREEN,
  },
  buttonText: { color: Colors.WHITE, fontSize: 16, fontWeight: '700' },
});
