import React, { useState, useRef } from 'react';
import {
  View,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { authService } from '../services/auth.service';
import { MIN_PASSWORD_LENGTH, passwordValidationError } from '../utils/password';
import { useSensitiveScreenProtection } from '../hooks/useSensitiveScreenProtection';

const BRAND_GREEN = '#1A5C3A';
const DARK_TEXT = '#0F1A14';
const GRAY_TEXT = '#6B7280';
const LABEL_COLOR = '#374151';
const BORDER_COLOR = '#E5E7EB';
const ERROR_RED = '#DC2626';
const WHITE = '#FFFFFF';
const SCREEN_BG = '#F8FAF9';
const FOCUS_BG = '#FAFFFE';
const BACK_BTN_BG = '#F3F4F6';
const TRACK_BG = '#EEF2F0';

// Same advisory strength signal as signup (RegistrationScreen): rewards length
// + character variety, while the enforceable policy remains length-first.
function passwordStrength(pw: string): { label: string; color: string; pct: number } {
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
  if (/\d/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  if (score <= 1) return { label: 'Weak', color: '#DC2626', pct: 33 };
  if (score <= 3) return { label: 'Fair', color: '#F59E0B', pct: 66 };
  return { label: 'Strong', color: '#16A34A', pct: 100 };
}

interface Props {
  navigation: any;
  route: { params?: { email?: string } };
}

export default function ResetPasswordScreen({ navigation, route }: Props) {
  useSensitiveScreenProtection();
  const email = route?.params?.email || '';

  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [focused, setFocused] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [resending, setResending] = useState(false);
  const [error, setError] = useState('');

  const passwordRef = useRef<TextInput>(null);
  const confirmRef = useRef<TextInput>(null);

  const codeValid = /^\d{6}$/.test(code);
  const passwordValid = passwordValidationError(password) === null;
  const confirmValid = confirm.length > 0 && confirm === password;
  const isValid = codeValid && passwordValid && confirmValid;
  const strength = passwordStrength(password);

  const handleReset = async () => {
    setError('');
    if (!codeValid) return setError('Enter the 6-digit code from your email');
    if (!passwordValid) return setError(passwordValidationError(password) || 'Password is too short');
    if (!confirmValid) return setError('Passwords do not match');

    setLoading(true);
    try {
      const result = await authService.confirmPasswordReset(email, code, password);
      if (!result.success) {
        setError(result.error || 'Could not reset your password. Please try again.');
        return;
      }
      Alert.alert(
        'Password updated',
        'Your password has been reset. Please log in with your new password.',
        [{ text: 'Log in', onPress: () => navigation.navigate('Login') }],
      );
    } catch (e: any) {
      setError(e.message || 'Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    setResending(true);
    setError('');
    try {
      const result = await authService.requestPasswordReset(email);
      if (!result.success) {
        setError(result.error || 'Could not resend the code. Please try again.');
        return;
      }
      Alert.alert('Code sent', `We've sent a new code to ${email}.`);
    } catch (e: any) {
      setError(e.message || 'Could not resend the code.');
    } finally {
      setResending(false);
    }
  };

  const fieldStyle = (name: string, hasError: boolean) => {
    if (hasError) return styles.inputError;
    if (focused === name) return styles.inputFocused;
    return null;
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <KeyboardAvoidingView style={styles.keyboardView} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <View style={styles.header}>
          <TouchableOpacity
            style={styles.backButton}
            activeOpacity={0.7}
            onPress={() => navigation.goBack()}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Text style={styles.backArrow}>‹</Text>
          </TouchableOpacity>
          <Text style={styles.title}>Reset Password</Text>
          <Text style={styles.subtitle}>
            Enter the 6-digit code sent to {email ? <Text style={styles.emailBold}>{email}</Text> : 'your email'} and
            choose a new password.
          </Text>
        </View>

        <ScrollView
          style={styles.scrollView}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.formCard}>
            {/* Code */}
            <View style={styles.fieldContainer}>
              <Text style={styles.label}>
                Reset Code<Text style={styles.required}> *</Text>
              </Text>
              <View style={[styles.inputWrapper, fieldStyle('code', false)]}>
                <Text style={styles.fieldIcon}>🔑</Text>
                <TextInput
                  style={[styles.input, styles.codeInput]}
                  placeholder="6-digit code"
                  placeholderTextColor="#9CA3AF"
                  value={code}
                  onChangeText={(t) => setCode(t.replace(/\D/g, '').slice(0, 6))}
                  onFocus={() => setFocused('code')}
                  onBlur={() => setFocused(null)}
                  keyboardType="number-pad"
                  returnKeyType="next"
                  maxLength={6}
                  onSubmitEditing={() => passwordRef.current?.focus()}
                />
                {codeValid && <Text style={styles.validIcon}>✓</Text>}
              </View>
            </View>

            {/* New password */}
            <View style={styles.fieldContainer}>
              <Text style={styles.label}>
                New Password<Text style={styles.required}> *</Text>
              </Text>
              <View style={[styles.inputWrapper, fieldStyle('password', false)]}>
                <Text style={styles.fieldIcon}>🔒</Text>
                <TextInput
                  ref={passwordRef}
                  style={styles.input}
                  placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
                  placeholderTextColor="#9CA3AF"
                  value={password}
                  onChangeText={setPassword}
                  onFocus={() => setFocused('password')}
                  onBlur={() => setFocused(null)}
                  secureTextEntry={!showPassword}
                  autoCapitalize="none"
                  autoCorrect={false}
                  returnKeyType="next"
                  onSubmitEditing={() => confirmRef.current?.focus()}
                />
                <TouchableOpacity onPress={() => setShowPassword((s) => !s)} activeOpacity={0.7} style={styles.eyeButton}>
                  <Text style={styles.eyeIcon}>{showPassword ? '👁' : '👁‍🗨'}</Text>
                </TouchableOpacity>
              </View>
              {password.length > 0 && (
                <View style={styles.strengthRow}>
                  <View style={styles.strengthTrack}>
                    <View style={[styles.strengthFill, { width: `${strength.pct}%`, backgroundColor: strength.color }]} />
                  </View>
                  <Text style={[styles.strengthLabel, { color: strength.color }]}>{strength.label}</Text>
                </View>
              )}
            </View>

            {/* Confirm password */}
            <View style={styles.fieldContainer}>
              <Text style={styles.label}>
                Confirm New Password<Text style={styles.required}> *</Text>
              </Text>
              <View style={[styles.inputWrapper, fieldStyle('confirm', confirm.length > 0 && !confirmValid)]}>
                <Text style={styles.fieldIcon}>🔒</Text>
                <TextInput
                  ref={confirmRef}
                  style={styles.input}
                  placeholder="Re-enter your new password"
                  placeholderTextColor="#9CA3AF"
                  value={confirm}
                  onChangeText={setConfirm}
                  onFocus={() => setFocused('confirm')}
                  onBlur={() => setFocused(null)}
                  secureTextEntry={!showConfirm}
                  autoCapitalize="none"
                  autoCorrect={false}
                  returnKeyType="done"
                  onSubmitEditing={handleReset}
                />
                <TouchableOpacity onPress={() => setShowConfirm((s) => !s)} activeOpacity={0.7} style={styles.eyeButton}>
                  <Text style={styles.eyeIcon}>{showConfirm ? '👁' : '👁‍🗨'}</Text>
                </TouchableOpacity>
              </View>
              {confirm.length > 0 && !confirmValid ? (
                <Text style={styles.errorText}>Passwords do not match</Text>
              ) : null}
            </View>

            {error ? <Text style={styles.formError}>{error}</Text> : null}
          </View>

          <TouchableOpacity
            style={[styles.primaryButton, (!isValid || loading) && styles.primaryButtonDisabled]}
            onPress={handleReset}
            disabled={!isValid || loading}
            activeOpacity={0.8}
          >
            <Text style={styles.primaryButtonText}>{loading ? 'Resetting...' : 'Reset password'}</Text>
            {!loading && <Text style={styles.primaryButtonArrow}>→</Text>}
          </TouchableOpacity>

          <TouchableOpacity style={styles.resendLink} onPress={handleResend} disabled={resending} activeOpacity={0.7}>
            <Text style={styles.resendText}>
              Didn't get a code? <Text style={styles.resendBold}>{resending ? 'Sending...' : 'Resend'}</Text>
            </Text>
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: SCREEN_BG },
  keyboardView: { flex: 1 },
  header: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 16, zIndex: 10 },
  backButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: BACK_BTN_BG,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 16,
  },
  backArrow: { fontSize: 22, color: DARK_TEXT, fontWeight: '600' },
  title: { fontFamily: 'Helvetica-Bold', fontSize: 26, color: DARK_TEXT, marginBottom: 6 },
  subtitle: { fontSize: 14, color: GRAY_TEXT, lineHeight: 20 },
  emailBold: { color: DARK_TEXT, fontWeight: '700' },
  scrollView: { flex: 1 },
  scrollContent: { paddingHorizontal: 16, paddingBottom: 40 },
  formCard: {
    backgroundColor: WHITE,
    borderRadius: 16,
    padding: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 2,
  },
  fieldContainer: { marginBottom: 20 },
  label: { fontSize: 13, color: LABEL_COLOR, fontWeight: '500', marginBottom: 6 },
  required: { color: ERROR_RED },
  inputWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 56,
    borderWidth: 1.5,
    borderColor: BORDER_COLOR,
    borderRadius: 12,
    paddingHorizontal: 16,
    backgroundColor: WHITE,
  },
  inputFocused: { borderColor: BRAND_GREEN, backgroundColor: FOCUS_BG, borderWidth: 2 },
  inputError: { borderColor: ERROR_RED },
  fieldIcon: { fontSize: 18, marginRight: 10, opacity: 0.5 },
  input: { flex: 1, fontSize: 15, color: DARK_TEXT, padding: 0 },
  codeInput: { letterSpacing: 6, fontWeight: '700' },
  validIcon: { fontSize: 18, color: BRAND_GREEN, fontWeight: '700', marginLeft: 8 },
  eyeButton: { padding: 4, marginLeft: 8 },
  eyeIcon: { fontSize: 18 },
  errorText: { fontSize: 11, color: ERROR_RED, marginTop: 6, marginLeft: 4 },
  formError: { fontSize: 13, color: ERROR_RED, marginTop: 4, textAlign: 'center' },
  strengthRow: { flexDirection: 'row', alignItems: 'center', marginTop: 10, marginLeft: 2 },
  strengthTrack: { flex: 1, height: 6, borderRadius: 3, backgroundColor: TRACK_BG, overflow: 'hidden' },
  strengthFill: { height: 6, borderRadius: 3 },
  strengthLabel: { fontSize: 12, fontWeight: '700', marginLeft: 10, width: 52, textAlign: 'right' },
  primaryButton: {
    height: 56,
    backgroundColor: BRAND_GREEN,
    borderRadius: 14,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 4,
    marginBottom: 16,
  },
  primaryButtonDisabled: { opacity: 0.6 },
  primaryButtonText: { fontFamily: 'Helvetica-Bold', fontSize: 16, color: WHITE },
  primaryButtonArrow: { fontSize: 18, color: WHITE, marginLeft: 8 },
  resendLink: { alignItems: 'center', marginTop: 4 },
  resendText: { fontSize: 14, color: GRAY_TEXT },
  resendBold: { color: BRAND_GREEN, fontWeight: '700' },
});
