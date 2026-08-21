import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  Keyboard,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AppTheme } from '../constants/theme';
import { useTheme } from '../components/ThemeProvider';
import { Spacing } from '../constants/spacing';
import { Typography } from '../constants/typography';
import { authService } from '../services/auth.service';
import { deviceSessionService } from '../services/deviceSession.service';
import { useSensitiveScreenProtection } from '../hooks/useSensitiveScreenProtection';

type Step = 'request' | 'code' | 'new' | 'confirm';
const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del'];
const KEY_SIZE = 64;

export default function ForgotPinScreen({ navigation }: { navigation: any }) {
  useSensitiveScreenProtection();
  const { theme } = useTheme();
  const styles = createStyles(theme);
  const [step, setStep] = useState<Step>('request');
  const [sentTo, setSentTo] = useState('your verified email');
  const [code, setCode] = useState('');
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sendCode = useCallback(async () => {
    if (busy) return;
    setBusy(true); setError(null);
    const result = await authService.requestPinReset();
    setBusy(false);
    if (!result.success) { setError(result.error || 'Could not send the reset code.'); return; }
    setSentTo(result.sentTo || 'your verified email');
    setStep('code');
  }, [busy]);

  const continueFromCode = useCallback(() => {
    if (!/^\d{6}$/.test(code)) { setError('Enter the 6-digit code.'); return; }
    setError(null); setStep('new');
  }, [code]);

  const finishReset = useCallback(async (first: string, second: string) => {
    if (first !== second) {
      setError('PINs do not match. Try again.'); setNewPin(''); setConfirmPin(''); setStep('new'); return;
    }
    setBusy(true); setError(null);
    const result = await authService.confirmPinReset(code, first);
    if (result.success) void deviceSessionService.notifyPinChanged().catch(() => {});
    setBusy(false);
    if (!result.success) {
      setError(result.error || 'Could not reset your PIN.');
      setNewPin(''); setConfirmPin('');
      if (/code|expired|attempt/i.test(result.error || '')) setStep('code'); else setStep('new');
      return;
    }
    Alert.alert('PIN reset', 'Your transaction PIN has been changed. Biometric authorization was turned off for security.', [
      { text: 'Done', onPress: () => navigation.goBack() },
    ]);
  }, [code, navigation]);

  const handleKey = useCallback((key: string) => {
    if (busy || step === 'request' || step === 'code') return;
    setError(null);
    if (key === 'del') {
      if (step === 'new') setNewPin((value) => value.slice(0, -1));
      else setConfirmPin((value) => value.slice(0, -1));
      return;
    }
    if (step === 'new') {
      const next = `${newPin}${key}`.slice(0, 4); setNewPin(next);
      if (next.length === 4) setStep('confirm');
    } else {
      const next = `${confirmPin}${key}`.slice(0, 4); setConfirmPin(next);
      if (next.length === 4) void finishReset(newPin, next);
    }
  }, [busy, step, newPin, confirmPin, finishReset]);

  const currentPin = step === 'confirm' ? confirmPin : newPin;
  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.header}>
          <TouchableOpacity style={styles.back} onPress={() => { Keyboard.dismiss(); navigation.goBack(); }}><Text style={styles.backText}>{'<'}</Text></TouchableOpacity>
          <Text style={styles.headerTitle}>Forgot transaction PIN</Text><View style={styles.back} />
        </View>
        <View style={styles.content}>
          {step === 'request' && <>
            <Text style={styles.title}>Reset your PIN</Text>
            <Text style={styles.subtitle}>We’ll send a secure 6-digit code to your verified email address.</Text>
            <TouchableOpacity style={styles.primaryButton} onPress={sendCode} disabled={busy}>
              {busy ? <ActivityIndicator color={"#FFFFFF"} /> : <Text style={styles.primaryText}>Send reset code</Text>}
            </TouchableOpacity>
          </>}
          {step === 'code' && <>
            <Text style={styles.title}>Enter verification code</Text>
            <Text style={styles.subtitle}>Enter the code sent to {sentTo}.</Text>
            <TextInput style={styles.codeInput} value={code} onChangeText={(v) => { setCode(v.replace(/\D/g, '').slice(0, 6)); setError(null); }} keyboardType="number-pad" maxLength={6} placeholder="000000" placeholderTextColor={theme.inkMuted} />
            <TouchableOpacity style={[styles.primaryButton, code.length !== 6 && styles.disabled]} onPress={continueFromCode} disabled={code.length !== 6 || busy}><Text style={styles.primaryText}>Continue</Text></TouchableOpacity>
            <TouchableOpacity style={styles.resend} onPress={sendCode} disabled={busy}><Text style={styles.resendText}>Send another code</Text></TouchableOpacity>
          </>}
          {(step === 'new' || step === 'confirm') && <>
            <Text style={styles.title}>{step === 'new' ? 'Create new PIN' : 'Confirm new PIN'}</Text>
            <Text style={styles.subtitle}>{step === 'new' ? 'Choose a new 4-digit transaction PIN.' : 'Enter the same PIN again.'}</Text>
            <View style={styles.dots}>{[0,1,2,3].map((i) => <View key={i} style={[styles.dot, i < currentPin.length && styles.dotFilled]} />)}</View>
            <View style={styles.keypad}>{KEYS.map((key, index) => key === '' ? <View key={`empty-${index}`} style={styles.key} /> : (
              <Pressable key={key} style={({ pressed }) => [styles.key, pressed && !busy && styles.keyPressed]} onPress={() => handleKey(key)} disabled={busy}>
                {({ pressed }) => <Text style={[styles.keyText, pressed && styles.keyTextPressed]}>{key === 'del' ? '⌫' : key}</Text>}
              </Pressable>
            ))}</View>
          </>}
          <View style={styles.status}>{busy && step !== 'request' ? <ActivityIndicator color={theme.brand} /> : error ? <Text style={styles.error}>{error}</Text> : null}</View>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.background }, flex: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: theme.border, paddingHorizontal: Spacing.M },
  back: { width: 48, height: 48, justifyContent: 'center', alignItems: 'center' }, backText: { fontSize: 28, color: theme.ink, fontWeight: '600' },
  headerTitle: { ...Typography.SCREEN_TITLE, color: theme.ink, flex: 1, textAlign: 'center', fontSize: 20 },
  content: { flex: 1, alignItems: 'center', padding: Spacing.XL, paddingTop: Spacing.XL * 2 },
  title: { ...Typography.HEADING, color: theme.ink, textAlign: 'center' },
  subtitle: { ...Typography.BODY, color: theme.inkMuted, textAlign: 'center', marginTop: Spacing.S, marginBottom: Spacing.XL },
  primaryButton: { width: '100%', height: Spacing.BUTTON_HEIGHT_PRIMARY, backgroundColor: theme.brand, borderRadius: Spacing.BUTTON_RADIUS, justifyContent: 'center', alignItems: 'center' },
  disabled: { opacity: 0.5 }, primaryText: { ...Typography.BUTTON_TEXT },
  codeInput: { width: '100%', height: Spacing.INPUT_HEIGHT, borderWidth: 1, borderColor: theme.border, borderRadius: Spacing.BUTTON_RADIUS, textAlign: 'center', fontSize: 26, letterSpacing: 10, color: theme.ink, marginBottom: Spacing.L },
  resend: { minHeight: 44, justifyContent: 'center', marginTop: Spacing.M }, resendText: { ...Typography.BODY, color: theme.brand, fontWeight: '700' },
  dots: { flexDirection: 'row', marginBottom: Spacing.L }, dot: { width: 16, height: 16, borderRadius: 8, borderWidth: 2, borderColor: theme.brand, marginHorizontal: Spacing.M }, dotFilled: { backgroundColor: theme.brand },
  keypad: { flexDirection: 'row', flexWrap: 'wrap', width: KEY_SIZE * 3 + Spacing.L * 2, justifyContent: 'space-between' },
  key: { width: KEY_SIZE, height: KEY_SIZE, borderRadius: KEY_SIZE / 2, justifyContent: 'center', alignItems: 'center', marginVertical: Spacing.S }, keyPressed: { backgroundColor: theme.brand },
  keyText: { fontSize: 26, color: theme.ink, fontWeight: '500' }, keyTextPressed: { color: "#FFFFFF" },
  status: { minHeight: 52, justifyContent: 'center', paddingTop: Spacing.M }, error: { ...Typography.ERROR, color: theme.down, textAlign: 'center' },
  });
}
