import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, AppStateStatus, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors } from '../constants/colors';
import { useTransactionAuth } from './TransactionAuthProvider';
import { deviceSessionService } from '../services/deviceSession.service';
import { authService } from '../services/auth.service';

const LOCK_AFTER_MS = 60 * 60 * 1000;

export function AppPrivacyGate({ children }: { children: React.ReactNode }) {
  const { authorize } = useTransactionAuth();
  const backgroundedAt = useRef<number | null>(null);
  const unlocking = useRef(false);
  const [privacyVisible, setPrivacyVisible] = useState(false);
  const [locked, setLocked] = useState(false);

  const unlock = useCallback(async () => {
    if (!locked || unlocking.current) return;
    unlocking.current = true;
    try {
      const result = await authorize({
        title: 'Unlock Kay’s Pay',
        subtitle: 'Confirm your PIN or biometric to continue',
      });
      if (result) setLocked(false);
    } finally {
      unlocking.current = false;
    }
  }, [authorize, locked]);

  useEffect(() => {
    const onStateChange = (next: AppStateStatus) => {
      if (next !== 'active') {
        if (backgroundedAt.current === null) backgroundedAt.current = Date.now();
        setPrivacyVisible(true);
        return;
      }

      const awayFor = backgroundedAt.current === null ? 0 : Date.now() - backgroundedAt.current;
      backgroundedAt.current = null;
      setPrivacyVisible(false);
      if (awayFor >= LOCK_AFTER_MS) {
        void authService.getCurrentSession().then((session) => {
          if (session) setLocked(true);
        });
      }
      void deviceSessionService.isRevoked().then((revoked) => {
        if (revoked) void authService.signOut();
      });
    };

    const change = AppState.addEventListener('change', onStateChange);
    // Android can blur while AppState remains active (notification shade or
    // app switcher). Mask immediately, but start the lock timer only when the
    // app actually backgrounds.
    const blur = AppState.addEventListener('blur', () => setPrivacyVisible(true));
    const focus = AppState.addEventListener('focus', () => {
      if (AppState.currentState === 'active') setPrivacyVisible(false);
    });
    return () => {
      change.remove();
      blur.remove();
      focus.remove();
    };
  }, []);

  useEffect(() => {
    if (locked) void unlock();
  }, [locked, unlock]);

  return (
    <View style={styles.root}>
      {children}
      {(privacyVisible || locked) && (
        <View style={styles.cover} accessibilityViewIsModal>
          <Ionicons name="shield-checkmark" size={52} color={Colors.GREEN} />
          <Text style={styles.title}>Kay’s Pay is protected</Text>
          {locked && (
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
