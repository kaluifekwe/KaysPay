import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  View,
  Text,
  Modal,
  StyleSheet,
  TouchableOpacity,
  Pressable,
  ActivityIndicator,
  Alert,
  AppState,
} from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import { Colors } from '../constants/colors';
import { Spacing } from '../constants/spacing';
import { Typography } from '../constants/typography';
import { authService } from '../services/auth.service';
import { walletService } from '../services/wallet.service';
import { withTimeout } from '../utils/network';
import { navigationRef } from '../navigation/navigationRef';
import { formatNaira } from '../utils/formatCurrency';
import { storageHelpers, StorageKeys } from '../lib/mmkv';

interface AuthorizeOptions {
  title?: string;
  /** Optional amount shown to the user so they know what they are approving. */
  amount?: number;
  subtitle?: string;
  /**
   * How many purchase calls this single PIN/biometric check should cover.
   * Only bulk-send needs more than the default of 1 — one PIN entry
   * authorizing many sequential per-recipient purchases, since a PIN prompt
   * per recipient would be unusable. Regular single purchases should leave
   * this unset.
   */
  maxUses?: number;
  /**
   * Skip the pre-PIN wallet-balance check. Set for actions that don't spend
   * FROM the wallet in the "fund to proceed" sense — e.g. a withdrawal, which
   * runs its own balance validation and where a "Fund Wallet" prompt would be
   * nonsensical.
   */
  skipBalanceCheck?: boolean;
  /** Distinguishes recovery from an ordinary cancelled authorization. */
  onForgotPin?: () => void;
}

export interface AuthorizeResult {
  /** Pass this to the purchase/withdrawal call as `auth_token`. */
  token: string;
  /**
   * The PIN that was just verified (typed, or read from the biometric-gated
   * keychain). Only needed by the "enable biometric" settings flow, which
   * has to store it for future biometric unlocks — regular purchase flows
   * should ignore this field.
   */
  pin: string;
}

interface TransactionAuthContextValue {
  /**
   * Ask the user to authorize a sensitive action. Resolves once they pass
   * biometric or enter the correct PIN, or null if they cancel/fail.
   */
  authorize: (options?: AuthorizeOptions) => Promise<AuthorizeResult | null>;
  /** True while the transaction PIN/biometric authorization sheet is open. */
  isAuthorizing: boolean;
}

const TransactionAuthContext = createContext<TransactionAuthContextValue>({
  authorize: async () => null,
  isAuthorizing: false,
});

export function useTransactionAuth() {
  return useContext(TransactionAuthContext);
}

const PIN_LENGTH = 4;

export function TransactionAuthProvider({ children }: { children: React.ReactNode }) {
  const [visible, setVisible] = useState(false);
  const [options, setOptions] = useState<AuthorizeOptions>({});
  const [pin, setPin] = useState('');
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const [lockRemainingSeconds, setLockRemainingSeconds] = useState(0);
  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const insets = useSafeAreaInsets();

  const resolverRef = useRef<((value: AuthorizeResult | null) => void) | null>(null);
  const maxUsesRef = useRef(1);
  // Re-entry guard for the manual-PIN-verification effect below — a ref,
  // not state, so flipping it doesn't itself re-trigger that effect.
  const checkingRef = useRef(false);
  const lockExpiresAtRef = useRef(0);
  const refreshingLockRef = useRef(false);

  const applyLockStatus = useCallback((status: { locked: boolean; retryAfterSeconds: number }) => {
    const seconds = status.locked ? Math.max(1, Math.ceil(status.retryAfterSeconds)) : 0;
    lockExpiresAtRef.current = seconds > 0 ? Date.now() + seconds * 1000 : 0;
    if (lockExpiresAtRef.current > 0) {
      void storageHelpers.setNumber(StorageKeys.PIN_LOCKED_UNTIL, lockExpiresAtRef.current);
    }
    setLockRemainingSeconds(seconds);
    setLocked(seconds > 0);
    if (seconds > 0) setError(null);
  }, []);

  const finish = useCallback((result: AuthorizeResult | null) => {
    setVisible(false);
    const resolve = resolverRef.current;
    resolverRef.current = null;
    // Reset for next time.
    setPin('');
    setError(null);
    setLocked(false);
    setLockRemainingSeconds(0);
    lockExpiresAtRef.current = 0;
    setChecking(false);
    checkingRef.current = false;
    if (result) void storageHelpers.delete(StorageKeys.PIN_LOCKED_UNTIL);
    resolve?.(result);
  }, []);

  const biometricUsable = useCallback(async () => {
    try {
      if (!(await authService.isBiometricEnabled())) return false;
      // Accounts that had biometric enabled before this step-up token system
      // existed never had a PIN written to the keychain — checking this
      // first avoids ever calling getBiometricPin() on an empty entry
      // (which can hang on some devices instead of cleanly returning null).
      if (!(await authService.hasBiometricPin())) return false;
      const [hasHardware, enrolled] = await Promise.all([
        LocalAuthentication.hasHardwareAsync(),
        LocalAuthentication.isEnrolledAsync(),
      ]);
      return hasHardware && enrolled;
    } catch {
      return false;
    }
  }, []);

  // Biometric doesn't prove anything to the server on its own — it gates
  // reading the PIN out of the device's hardware-backed keychain, and that
  // PIN then goes through the exact same server-side verify_user_pin check
  // as manual entry, so the resulting token is equally trustworthy.
  const tryBiometric = useCallback(async () => {
    try {
      const pinFromKeychain = await authService.getBiometricPin();
      if (!pinFromKeychain) return; // not enrolled/declined — fall back to manual PIN

      setChecking(true);
      const res = await authService.verifyPIN(pinFromKeychain, maxUsesRef.current);
      setChecking(false);

      if (res.valid && res.token) {
        finish({ token: res.token, pin: pinFromKeychain });
      } else if (res.restricted || res.error === 'FINANCIAL_ACTIONS_RESTRICTED') {
        setError('Financial transactions are temporarily restricted for your protection. Reset your transaction PIN using your verified email or contact support.');
      } else if (res.locked) {
        const fallbackSeconds = res.lockedUntil
          ? Math.max(1, Math.ceil((new Date(res.lockedUntil).getTime() - Date.now()) / 1000))
          : 15 * 60;
        applyLockStatus({ locked: true, retryAfterSeconds: fallbackSeconds });
      }
      // If it somehow fails (PIN changed since last biometric enrollment,
      // etc.), silently fall back to manual PIN entry instead of showing an
      // error the user can't act on.
    } catch {
      setChecking(false);
      // fall back to PIN silently
    }
  }, [applyLockStatus, finish]);

  const showPinModal = useCallback(
    (opts: AuthorizeOptions, resolve: (value: AuthorizeResult | null) => void) => {
      resolverRef.current = resolve;
      maxUsesRef.current = opts?.maxUses && opts.maxUses > 1 ? opts.maxUses : 1;
      checkingRef.current = false;
      setOptions(opts || {});
      setPin('');
      setError(null);
      setLocked(false);
      setLockRemainingSeconds(0);
      lockExpiresAtRef.current = 0;
      setChecking(false);
      setVisible(true);

      // Offer biometric immediately if it is set up on this device.
      void (async () => {
        const localLockedUntil = await storageHelpers.getNumber(StorageKeys.PIN_LOCKED_UNTIL);
        if (resolverRef.current !== resolve) return;
        if (localLockedUntil && localLockedUntil > Date.now()) {
          applyLockStatus({
            locked: true,
            retryAfterSeconds: Math.ceil((localLockedUntil - Date.now()) / 1000),
          });
        }

        try {
          const status = await authService.getPINLockStatusStrict();
          if (resolverRef.current !== resolve) return;
          applyLockStatus(status);
          if (status.locked) return;
          await storageHelpers.delete(StorageKeys.PIN_LOCKED_UNTIL);
          const usable = await biometricUsable();
          if (resolverRef.current !== resolve) return;
          setBiometricAvailable(usable);
          if (usable) void tryBiometric();
        } catch {
          // Keep any known local lock. A typed PIN still goes through the
          // authoritative server RPC, so a status-check outage cannot bypass
          // the actual lockout.
        }
      })();
    },
    [applyLockStatus, biometricUsable, tryBiometric],
  );

  const refreshLockStatus = useCallback(async () => {
    if (!visible || refreshingLockRef.current) return;
    refreshingLockRef.current = true;
    try {
      const status = await authService.getPINLockStatusStrict();
      applyLockStatus(status);
      if (!status.locked) await storageHelpers.delete(StorageKeys.PIN_LOCKED_UNTIL);
    } catch {
      // Keep the modal locked and retry shortly. A status outage must never
      // turn an existing lock into an unlocked keypad.
      const retrySeconds = 5;
      lockExpiresAtRef.current = Date.now() + retrySeconds * 1000;
      setLockRemainingSeconds(retrySeconds);
      setLocked(true);
    } finally {
      refreshingLockRef.current = false;
    }
  }, [applyLockStatus, visible]);

  useEffect(() => {
    if (!visible || !locked) return;
    const update = () => {
      const seconds = Math.max(0, Math.ceil((lockExpiresAtRef.current - Date.now()) / 1000));
      setLockRemainingSeconds(seconds);
      if (seconds === 0) {
        void refreshLockStatus();
      }
    };
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [visible, locked, refreshLockStatus]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active' && visible) void refreshLockStatus();
    });
    return () => subscription.remove();
  }, [refreshLockStatus, visible]);

  const authorize = useCallback(
    (opts?: AuthorizeOptions) => {
      return new Promise<AuthorizeResult | null>((resolve) => {
        const amount = opts?.amount;

        // Show the PIN pad IMMEDIATELY — the user can start entering their PIN
        // right away instead of staring at a frozen screen while a wallet
        // round trip completes first (a visible stall on poor connections).
        showPinModal(opts || {}, resolve);

        // In parallel, check the balance so we can still warn early with a
        // "Fund Wallet" shortcut if the wallet can't cover this. This never
        // blocks the PIN pad. If it loses the race (the user enters a valid
        // PIN before it returns), we drop it — the server's atomic debit stays
        // the authority and returns "Insufficient balance" cleanly. If the
        // balance can't be read (offline/timeout), we do nothing and let the
        // server enforce it.
        if (amount && amount > 0 && !opts?.skipBalanceCheck) {
          (async () => {
            try {
              const r = await withTimeout(walletService.getWallet());
              // Only act if THIS authorize is still pending — finish() clears
              // resolverRef, so a mismatch means the user already resolved
              // (passed/cancelled) and we must not disturb them.
              if (resolverRef.current !== resolve) return;
              if (r.success && r.wallet && r.wallet.available_balance < amount) {
                const shortfall = amount - r.wallet.available_balance;
                Alert.alert(
                  'Insufficient Balance',
                  `You need ${formatNaira(shortfall)} more to complete this. Fund your wallet to continue.`,
                  [
                    { text: 'Cancel', style: 'cancel', onPress: () => finish(null) },
                    {
                      text: 'Fund Wallet',
                      onPress: () => {
                        finish(null);
                        if (navigationRef.isReady()) navigationRef.navigate('WalletFunding' as never);
                      },
                    },
                  ],
                  { cancelable: true, onDismiss: () => finish(null) },
                );
              }
            } catch {
              // balance unreadable — proceed; the server still enforces it
            }
          })();
        }
      });
    },
    [showPinModal, finish],
  );

  // Verify automatically once the PIN is fully entered. Guarded by a ref,
  // NOT the `checking` state — `checking` is only there to drive the
  // spinner. If it were also a dependency of this effect (as it used to
  // be), setting it to true would itself re-trigger the effect, which
  // would immediately bail out (checking is now true) and mark THIS run
  // "cancelled" — so when the real server response came back, it got
  // silently discarded and the spinner never cleared, no matter how long
  // you waited. That was the actual bug behind every "stuck on loading"
  // report — nothing to do with network speed or a stale build.
  useEffect(() => {
    if (pin.length !== PIN_LENGTH || checkingRef.current || !visible) return;

    checkingRef.current = true;
    setChecking(true);
    let cancelled = false;

    (async () => {
      const res = await authService.verifyPIN(pin, maxUsesRef.current);
      if (cancelled) return;
      checkingRef.current = false;

      if (res.valid && res.token) {
        finish({ token: res.token, pin });
        return;
      }

      if (res.restricted || res.error === 'FINANCIAL_ACTIONS_RESTRICTED') {
        setError('Financial transactions are temporarily restricted for your protection. Reset your transaction PIN using your verified email or contact support.');
      } else if (res.locked) {
        const fallbackSeconds = res.lockedUntil
          ? Math.max(1, Math.ceil((new Date(res.lockedUntil).getTime() - Date.now()) / 1000))
          : 15 * 60;
        applyLockStatus({ locked: true, retryAfterSeconds: fallbackSeconds });
        void refreshLockStatus();
      } else if (res.error === 'NO_PIN_SET') {
        setError('No PIN set. Please set up your PIN first.');
      } else if (typeof res.attemptsRemaining === 'number') {
        setError(`Incorrect PIN. ${res.attemptsRemaining} attempt(s) left.`);
      } else if (res.error) {
        // A genuine failure (network timeout, unexpected server error) —
        // show it as-is rather than the misleading "Incorrect PIN" below,
        // which implies the PIN itself was wrong when it may never have
        // actually been checked.
        setError(res.error);
      } else {
        setError('Incorrect PIN. Please try again.');
      }
      setPin('');
      setChecking(false);
    })();

    return () => {
      cancelled = true;
      checkingRef.current = false;
    };
  }, [pin, visible, finish, applyLockStatus, refreshLockStatus]);

  const handleKey = useCallback(
    (key: string) => {
      if (checking || locked) return;
      setError(null);
      if (key === 'del') {
        setPin((p) => p.slice(0, -1));
      } else if (pin.length < PIN_LENGTH) {
        setPin((p) => p + key);
      }
    },
    [checking, locked, pin.length],
  );

  const keypad = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'bio', '0', 'del'];

  return (
    <TransactionAuthContext.Provider value={{ authorize, isAuthorizing: visible }}>
      {children}

      <Modal visible={visible} transparent animationType="fade" onRequestClose={() => finish(null)}>
        <View style={styles.overlay}>
          <View style={[styles.card, { paddingBottom: insets.bottom + Spacing.L }]}>
            <Text style={styles.title}>{options.title || 'Confirm Transaction'}</Text>
            {typeof options.amount === 'number' && (
              <Text style={styles.amount}>{formatNaira(options.amount)}</Text>
            )}
            <Text style={styles.subtitle}>
              {options.subtitle || 'Enter your PIN to authorize'}
            </Text>

            <View style={styles.dots}>
              {Array.from({ length: PIN_LENGTH }).map((_, i) => (
                <View key={i} style={[styles.dot, i < pin.length && styles.dotFilled]} />
              ))}
            </View>

            <View style={styles.statusRow}>
              {checking ? (
                <ActivityIndicator color={Colors.GREEN} />
              ) : locked ? (
                <Text style={styles.error}>
                  Too many incorrect attempts. Try again in {Math.floor(lockRemainingSeconds / 60)}:{String(lockRemainingSeconds % 60).padStart(2, '0')}.
                </Text>
              ) : error ? (
                <Text style={styles.error}>{error}</Text>
              ) : (
                <Text style={styles.hint}> </Text>
              )}
            </View>

            <View style={styles.keypad}>
              {keypad.map((key) => {
                if (key === 'bio') {
                  return (
                    <TouchableOpacity
                      key="bio"
                      style={styles.key}
                      onPress={tryBiometric}
                      disabled={!biometricAvailable || locked}
                      activeOpacity={0.7}
                    >
                      <Text style={[styles.keyText, !biometricAvailable && styles.keyDisabled]}>
                        {biometricAvailable ? '☝️' : ''}
                      </Text>
                    </TouchableOpacity>
                  );
                }
                if (key === 'del') {
                  return (
                    <TouchableOpacity
                      key="del"
                      style={styles.key}
                      onPress={() => handleKey('del')}
                      activeOpacity={0.7}
                    >
                      <Text style={styles.keyText}>⌫</Text>
                    </TouchableOpacity>
                  );
                }
                return (
                  <Pressable
                    key={key}
                    style={({ pressed }) => [styles.key, pressed && !locked && styles.keyPressed]}
                    onPress={() => handleKey(key)}
                    disabled={locked}
                  >
                    {({ pressed }) => (
                      <Text style={[styles.keyText, pressed && !locked && styles.keyTextPressed]}>
                        {key}
                      </Text>
                    )}
                  </Pressable>
                );
              })}
            </View>

            <TouchableOpacity
              style={styles.forgotPin}
              onPress={() => {
                const onForgotPin = options.onForgotPin;
                finish(null);
                if (onForgotPin) {
                  onForgotPin();
                } else if (navigationRef.isReady()) {
                  navigationRef.navigate('Main', { screen: 'ForgotPin' });
                }
              }}
              disabled={checking}
              activeOpacity={0.7}
            >
              <Text style={styles.forgotPinText}>Forgot transaction PIN?</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.cancel} onPress={() => finish(null)} activeOpacity={0.7}>
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </TransactionAuthContext.Provider>
  );
}

const KEY_SIZE = 64;

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: Colors.OVERLAY,
    justifyContent: 'flex-end',
  },
  card: {
    backgroundColor: Colors.WHITE,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: Spacing.XL,
    paddingTop: Spacing.XL,
    alignItems: 'center',
  },
  title: {
    ...Typography.HEADING,
    color: Colors.DARK,
    textAlign: 'center',
  },
  amount: {
    ...Typography.SCREEN_TITLE,
    color: Colors.GREEN,
    marginTop: Spacing.S,
  },
  subtitle: {
    ...Typography.BODY,
    color: Colors.GRAY,
    textAlign: 'center',
    marginTop: Spacing.S,
  },
  dots: {
    flexDirection: 'row',
    justifyContent: 'center',
    marginTop: Spacing.XL,
    marginBottom: Spacing.M,
  },
  dot: {
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: Colors.GREEN,
    marginHorizontal: Spacing.M,
  },
  dotFilled: {
    backgroundColor: Colors.GREEN,
  },
  statusRow: {
    height: 24,
    justifyContent: 'center',
    marginBottom: Spacing.M,
  },
  error: {
    ...Typography.CAPTION,
    color: Colors.RED,
    textAlign: 'center',
  },
  hint: {
    ...Typography.CAPTION,
  },
  keypad: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    width: KEY_SIZE * 3 + Spacing.L * 2,
    justifyContent: 'space-between',
  },
  key: {
    width: KEY_SIZE,
    height: KEY_SIZE,
    borderRadius: KEY_SIZE / 2,
    justifyContent: 'center',
    alignItems: 'center',
    marginVertical: Spacing.S,
  },
  keyPressed: {
    backgroundColor: Colors.GREEN,
  },
  keyText: {
    fontSize: 26,
    color: Colors.DARK,
    fontWeight: '500',
  },
  keyTextPressed: {
    color: Colors.WHITE,
  },
  keyDisabled: {
    color: Colors.BORDER,
  },
  cancel: {
    marginTop: Spacing.S,
    height: Spacing.TOUCH_TARGET_MIN,
    justifyContent: 'center',
    alignItems: 'center',
  },
  forgotPin: {
    minHeight: Spacing.TOUCH_TARGET_MIN,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: Spacing.M,
  },
  forgotPinText: {
    ...Typography.BODY,
    color: Colors.GREEN,
    fontWeight: '700',
  },
  cancelText: {
    ...Typography.BUTTON_TEXT,
    color: Colors.GRAY,
  },
});
