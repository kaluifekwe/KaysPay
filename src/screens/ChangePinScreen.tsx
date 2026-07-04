import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  SafeAreaView,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { Colors } from '../constants/colors';
import { Spacing } from '../constants/spacing';
import { Typography } from '../constants/typography';
import { authService } from '../services/auth.service';
import { useTransactionAuth } from '../components/TransactionAuthProvider';

interface ChangePinScreenProps {
  navigation: any;
}

const PIN_LENGTH = 4;

export default function ChangePinScreen({ navigation }: ChangePinScreenProps) {
  const { authorize } = useTransactionAuth();
  const [step, setStep] = useState<'verifying' | 'new' | 'confirm'>('verifying');
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const startedRef = useRef(false);

  // Prove identity (current PIN or biometric) before allowing a change —
  // unless there's no PIN yet at all, in which case there's nothing to prove
  // and this is really first-time setup (same as the onboarding PIN screen).
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    (async () => {
      const alreadyHasPin = await authService.hasPIN();
      if (!alreadyHasPin) {
        setStep('new');
        return;
      }

      const authResult = await authorize({ title: 'Verify it’s you', subtitle: 'Authorize to change your PIN' });
      if (!authResult) {
        navigation.goBack();
        return;
      }
      setStep('new');
    })();
  }, [authorize, navigation]);

  const current = step === 'confirm' ? confirmPin : newPin;

  const save = useCallback(
    async (firstPin: string, secondPin: string) => {
      if (firstPin !== secondPin) {
        setError('PINs do not match. Try again.');
        setNewPin('');
        setConfirmPin('');
        setStep('new');
        return;
      }
      setSaving(true);
      const result = await authService.savePIN(firstPin);
      if (result.success && (await authService.isBiometricEnabled())) {
        // Keep the biometric-gated keychain entry in sync with the new PIN —
        // otherwise Face ID/fingerprint would keep authorizing with the OLD
        // PIN's value until re-enabled manually.
        await authService.saveBiometricPin(firstPin);
      }
      setSaving(false);
      if (result.success) {
        Alert.alert('PIN Updated', 'Your transaction PIN has been changed.', [
          { text: 'OK', onPress: () => navigation.goBack() },
        ]);
      } else {
        setError(result.error || 'Could not update PIN. Try again.');
        setNewPin('');
        setConfirmPin('');
        setStep('new');
      }
    },
    [navigation],
  );

  const handleKey = useCallback(
    (key: string) => {
      if (saving) return;
      setError(null);

      if (key === 'del') {
        if (step === 'confirm') setConfirmPin((p) => p.slice(0, -1));
        else setNewPin((p) => p.slice(0, -1));
        return;
      }

      if (step === 'new') {
        const next = newPin + key;
        if (next.length <= PIN_LENGTH) setNewPin(next);
        if (next.length === PIN_LENGTH) setStep('confirm');
      } else if (step === 'confirm') {
        const next = confirmPin + key;
        if (next.length <= PIN_LENGTH) setConfirmPin(next);
        if (next.length === PIN_LENGTH) save(newPin, next);
      }
    },
    [saving, step, newPin, confirmPin, save],
  );

  if (step === 'verifying') {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          <ActivityIndicator size="large" color={Colors.GREEN} />
        </View>
      </SafeAreaView>
    );
  }

  const keypad = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del'];

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backButton} onPress={() => navigation.goBack()} activeOpacity={0.7}>
          <Text style={styles.backButtonText}>‹</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Change PIN</Text>
        <View style={styles.headerSpacer} />
      </View>

      <View style={styles.content}>
        <Text style={styles.title}>
          {step === 'new' ? 'Enter new PIN' : 'Confirm new PIN'}
        </Text>
        <Text style={styles.subtitle}>
          {step === 'new' ? 'Choose a 4-digit transaction PIN' : 'Re-enter your new PIN'}
        </Text>

        <View style={styles.dots}>
          {Array.from({ length: PIN_LENGTH }).map((_, i) => (
            <View key={i} style={[styles.dot, i < current.length && styles.dotFilled]} />
          ))}
        </View>

        <View style={styles.statusRow}>
          {saving ? (
            <ActivityIndicator color={Colors.GREEN} />
          ) : error ? (
            <Text style={styles.error}>{error}</Text>
          ) : (
            <Text style={styles.hint}> </Text>
          )}
        </View>

        <View style={styles.keypad}>
          {keypad.map((key, idx) => {
            if (key === '') return <View key={`empty-${idx}`} style={styles.key} />;
            return (
              <TouchableOpacity
                key={key}
                style={styles.key}
                onPress={() => handleKey(key)}
                activeOpacity={0.7}
                disabled={saving}
              >
                <Text style={styles.keyText}>{key === 'del' ? '⌫' : key}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>
    </SafeAreaView>
  );
}

const KEY_SIZE = 64;

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.WHITE },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.L,
    paddingVertical: Spacing.M,
    borderBottomWidth: 1,
    borderBottomColor: Colors.BORDER,
  },
  backButton: { width: 48, height: 48, justifyContent: 'center', alignItems: 'center' },
  backButtonText: { fontSize: 28, fontWeight: '600', color: Colors.DARK },
  headerTitle: { ...Typography.SCREEN_TITLE, flex: 1, textAlign: 'center' },
  headerSpacer: { width: 48 },
  content: { flex: 1, alignItems: 'center', paddingTop: Spacing.XL * 2 },
  title: { ...Typography.HEADING, color: Colors.DARK },
  subtitle: { ...Typography.BODY, color: Colors.GRAY, marginTop: Spacing.S, textAlign: 'center' },
  dots: { flexDirection: 'row', justifyContent: 'center', marginTop: Spacing.XL, marginBottom: Spacing.M },
  dot: {
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: Colors.GREEN,
    marginHorizontal: Spacing.M,
  },
  dotFilled: { backgroundColor: Colors.GREEN },
  statusRow: { height: 24, justifyContent: 'center', marginBottom: Spacing.M },
  error: { ...Typography.CAPTION, color: Colors.RED, textAlign: 'center' },
  hint: { ...Typography.CAPTION },
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
  keyText: { fontSize: 26, color: Colors.DARK, fontWeight: '500' },
});
