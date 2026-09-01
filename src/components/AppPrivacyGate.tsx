import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, AppStateStatus, Image, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { AppTheme } from '../constants/theme';
import { useTheme } from './ThemeProvider';
import { useTransactionAuth } from './TransactionAuthProvider';
import { deviceSessionService } from '../services/deviceSession.service';
import { authService, APP_GATE_STATUS_TIMEOUT_MS, PINLockStatus } from '../services/auth.service';
import { supabase } from '../lib/supabase';
import { storageHelpers, StorageKeys } from '../lib/mmkv';

const LOCK_AFTER_MS = 60 * 60 * 1000;
// How often the "still active" heartbeat re-persists while foregrounded —
// see the heartbeat effect below. Far more often than needed for accuracy
// (only needs to land within LOCK_AFTER_MS of the real backgrounding time),
// chosen mainly so a very short foreground session still gets at least one
// heartbeat written before it ends.
const HEARTBEAT_INTERVAL_MS = 60 * 1000;

export function AppPrivacyGate({ children }: { children: React.ReactNode }) {
  const { authorize } = useTransactionAuth();
  const { theme } = useTheme();
  const styles = createStyles(theme);
  const backgroundedAt = useRef<number | null>(null);
  const heartbeatInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  const unlocking = useRef(false);
  const checkingRef = useRef(false);
  // A check requested while another was mid-flight, replayed on completion.
  const pendingRecheckRef = useRef(false);
  // Whether the current lock is the away-too-long one (local policy) rather
  // than a server PIN lockout — the server confirm must not clear it.
  const awayLockRef = useRef(false);
  // Freshest server lock status, handed to authorize() so the unlock path
  // doesn't re-fetch what was just retrieved.
  const lockStatusRef = useRef<PINLockStatus | null>(null);
  const [locked, setLocked] = useState(false);
  const [checkingSecurity, setCheckingSecurity] = useState(true);
  const [securityError, setSecurityError] = useState<string | null>(null);

  const checkSecurity = useCallback(async () => {
    // A call arriving while one is already running used to be dropped
    // outright. The server phase below widens that window, so instead of
    // losing the newer request it is remembered and replayed once this run
    // finishes — otherwise a foreground/SIGNED_IN check could be silently
    // swallowed and the gate left showing a stale decision.
    if (checkingRef.current) {
      pendingRecheckRef.current = true;
      return;
    }
    checkingRef.current = true;
    // Scope the cached status to this run. A leftover one from an earlier
    // check could otherwise be handed to authorize() as if it were current;
    // clearing it means the unlock path either gets a status this run
    // actually fetched, or falls back to fetching its own.
    lockStatusRef.current = null;
    setSecurityError(null);
    try {
      const session = await authService.getCurrentSession();
      if (!session) {
        awayLockRef.current = false;
        backgroundedAt.current = null;
        setLocked(false);
        setCheckingSecurity(false);
        await Promise.all([
          storageHelpers.delete(StorageKeys.PRIVACY_BACKGROUNDED_AT),
          storageHelpers.delete(StorageKeys.PIN_LOCKED_UNTIL),
        ]);
        return;
      }

      // ---- Phase 1: decide locally, then release the cover immediately. ----
      // Both lock reasons are already knowable on-device: the away-too-long
      // rule is pure arithmetic on a stored timestamp, and a live PIN lockout
      // deadline was persisted the last time the server reported one. Waiting
      // on the network to learn what we can compute here is what made every
      // cold start sit behind a security screen.
      const [storedBackgroundedAt, storedLockedUntil, storedLastActiveAt] = await Promise.all([
        storageHelpers.getNumber(StorageKeys.PRIVACY_BACKGROUNDED_AT),
        storageHelpers.getNumber(StorageKeys.PIN_LOCKED_UNTIL),
        storageHelpers.getNumber(StorageKeys.LAST_ACTIVE_AT),
      ]);

      // storedBackgroundedAt is the precise signal and wins whenever it
      // exists. storedLastActiveAt (the heartbeat) is consulted only when it
      // doesn't — exactly the case where the backgrounding write got lost to
      // a process kill, which is also the only case where it's needed: if
      // the app is closing normally, backgroundedAt lands fine.
      const wasAwayTooLong = typeof storedBackgroundedAt === 'number'
        ? Date.now() - storedBackgroundedAt >= LOCK_AFTER_MS
        : typeof storedLastActiveAt === 'number' && Date.now() - storedLastActiveAt >= LOCK_AFTER_MS;
      const locallyPinLocked = typeof storedLockedUntil === 'number' &&
        storedLockedUntil > Date.now();

      awayLockRef.current = wasAwayTooLong;
      setLocked(wasAwayTooLong || locallyPinLocked);
      setCheckingSecurity(false);

      // ---- Phase 2: confirm with the server, without blocking entry. ----
      // If the server disagrees the gate re-locks a moment later. The window
      // this opens exposes cached balance/history only: a PIN lockout has
      // never gated app access, and every money action independently
      // re-verifies server-side before it can move a naira.
      try {
        const status = await authService.getPINLockStatusStrict(APP_GATE_STATUS_TIMEOUT_MS);
        lockStatusRef.current = status;
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

        // No PIN lockout server-side. Clear any stale local deadline, but
        // never let that clear the separate away-too-long lock, which the
        // server knows nothing about.
        await storageHelpers.delete(StorageKeys.PIN_LOCKED_UNTIL);
        setLocked(awayLockRef.current);
        if (!awayLockRef.current) {
          backgroundedAt.current = null;
          await storageHelpers.delete(StorageKeys.PRIVACY_BACKGROUNDED_AT);
        }
      } catch {
        // Status unknown. The local decision already stands and the user may
        // well be inside the app by now, so this must not throw them onto an
        // error screen. The next foreground re-checks, and the PIN verify RPC
        // stays authoritative for anything that actually spends money.
        lockStatusRef.current = null;
      }
    } catch {
      // Couldn't even establish whether there is a session — a genuinely
      // unknown security state, so hold the cover and offer a retry.
      awayLockRef.current = false;
      lockStatusRef.current = null;
      setLocked(true);
      setCheckingSecurity(false);
      setSecurityError('Unable to confirm your security status. Check your connection and try again.');
    } finally {
      checkingRef.current = false;
      if (pendingRecheckRef.current) {
        pendingRecheckRef.current = false;
        void checkSecurity();
      }
    }
  }, []);

  const unlock = useCallback(async () => {
    if (!locked || unlocking.current) return;
    unlocking.current = true;
    try {
      const result = await authorize({
        title: 'Unlock KaysPay',
        subtitle: 'Confirm your PIN or biometric to continue',
        // Skips a redundant lock-status round trip when the check above
        // already fetched one; null just means it falls back to fetching.
        knownLockStatus: lockStatusRef.current ?? undefined,
      });
      if (result) {
        awayLockRef.current = false;
        backgroundedAt.current = null;
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

    // Backup for the PRIVACY_BACKGROUNDED_AT write below, which fires
    // unawaited at the exact instant the app backgrounds — also the moment
    // Android is likeliest to kill the process to reclaim memory, especially
    // after a long stretch backgrounded on the lower-RAM devices this app
    // targets. If that write is lost, checkSecurity's away-too-long check
    // has nothing to compare against and the lock is silently skipped no
    // matter how long the phone actually sat untouched. This re-persists
    // "still active as of now" every HEARTBEAT_INTERVAL_MS while foregrounded
    // as a second, sturdier signal it can fall back to instead — same
    // start/stop shape as supabase.auth's auto-refresh just above, since it
    // has the identical requirement of not running while backgrounded (RN
    // suspends JS timers there anyway, but the interval must still be
    // explicitly cleared or it leaks across the transition).
    const startHeartbeat = () => {
      if (heartbeatInterval.current !== null) return;
      void storageHelpers.setNumber(StorageKeys.LAST_ACTIVE_AT, Date.now());
      heartbeatInterval.current = setInterval(() => {
        void storageHelpers.setNumber(StorageKeys.LAST_ACTIVE_AT, Date.now());
      }, HEARTBEAT_INTERVAL_MS);
    };
    const stopHeartbeat = () => {
      if (heartbeatInterval.current === null) return;
      clearInterval(heartbeatInterval.current);
      heartbeatInterval.current = null;
    };
    startHeartbeat();

    const onStateChange = (next: AppStateStatus) => {
      if (next !== 'active') {
        if (backgroundedAt.current === null) {
          backgroundedAt.current = Date.now();
          void storageHelpers.setNumber(
            StorageKeys.PRIVACY_BACKGROUNDED_AT,
            backgroundedAt.current,
          );
        }
        stopHeartbeat();
        supabase.auth.stopAutoRefresh();
        return;
      }

      supabase.auth.startAutoRefresh();
      startHeartbeat();

      // backgroundedAt.current is deliberately NOT reset here. This used to
      // unconditionally null it on every foreground, which was a real PIN
      // bypass: background the app while it's sitting locked on the PIN
      // screen (never entering it), foreground again, and this ran BEFORE
      // checkSecurity had a chance to confirm anything — so the very next
      // backgrounding saw backgroundedAt.current === null and overwrote
      // PRIVACY_BACKGROUNDED_AT with "just now", erasing the original
      // hours-old away timestamp. Reopening after that found nothing to
      // suggest a long absence and skipped the lock entirely. It is now
      // cleared only where the lock is actually resolved — no session,
      // confirmed not locked, or a successful unlock — the same three
      // places PRIVACY_BACKGROUNDED_AT itself already gets cleared.
      void checkSecurity();
      void deviceSessionService.isRevoked().then((revoked) => {
        if (revoked) void authService.signOut();
      });
    };

    const change = AppState.addEventListener('change', onStateChange);
    return () => {
      change.remove();
      stopHeartbeat();
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
        <View
          style={[styles.cover, checkingSecurity && styles.coverSplash]}
          accessibilityViewIsModal
        >
          {checkingSecurity ? (
            // A routine launch shouldn't look like a security challenge, so
            // this deliberately mirrors the native splash (same image, width
            // and background as app.json's expo-splash-screen config) and the
            // handover between them is invisible. The shield and "protected"
            // wording are reserved for an actual lock.
            <>
              <Image
                source={require('../../assets/splash-screen.png')}
                style={styles.splashImage}
                resizeMode="contain"
              />
              <ActivityIndicator color="#FFFFFF" style={styles.splashSpinner} />
            </>
          ) : (
            <>
              <Ionicons name="shield-checkmark" size={52} color={theme.brand} />
              <Text style={styles.title}>KaysPay is protected</Text>
              {securityError ? (
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
            </>
          )}
        </View>
      )}
    </View>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
  root: { flex: 1 },
  cover: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 1000,
    elevation: 1000,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.background,
    padding: 24,
  },
  // Deliberately NOT theme-reactive: matches app.json's fixed native
  // expo-splash-screen backgroundColor (#1A5C3A), which cannot itself change
  // with the in-app theme toggle, so this cover must stay fixed too or the
  // handover between native splash and this cover would visibly flash.
  coverSplash: { backgroundColor: '#1A5C3A' },
  splashImage: { width: 240 },
  splashSpinner: { marginTop: 28 },
  title: { marginTop: 14, fontSize: 20, fontWeight: '700', color: theme.ink },
  message: { marginTop: 16, maxWidth: 300, textAlign: 'center', color: theme.inkMuted, fontSize: 14, lineHeight: 20 },
  button: {
    marginTop: 24,
    minWidth: 160,
    minHeight: 48,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.brand,
  },
  buttonText: { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },
  });
}
