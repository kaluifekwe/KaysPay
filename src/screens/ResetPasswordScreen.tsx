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
import { AppTheme } from '../constants/theme';
import { useTheme } from '../components/ThemeProvider';

// Same advisory strength signal as signup (RegistrationScreen): rewards length
// + character variety, while the enforceable policy remains length-first.
function passwordStrength(pw: string, theme: AppTheme): { label: string; color: string; pct: number } {
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
  if (/\d/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  if (score <= 1) return { label: 'Weak', color: theme.down, pct: 33 };
  if (score <= 3) return { label: 'Fair', color: theme.gold, pct: 66 };
  return { label: 'Strong', color: theme.brand, pct: 100 };
}

interface Props {
  navigation: any;
  route: { params?: { email?: string } };
}

export default function ResetPasswordScreen({ navigation, route }: Props) {
  useSensitiveScreenProtection();
  const { theme } = useTheme();
  const styles = createStyles(theme);
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
  const strength = passwordStrength(password, theme);

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
                  placeholderTextColor={theme.inkMuted}
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
                  placeholderTextColor={theme.inkMuted}
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
                  placeholderTextColor={theme.inkMuted}
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

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.background },
  keyboardView: { flex: 1 },
  header: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 16, zIndex: 10 },
  backButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: theme.surfaceRaised,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 16,
  },
  backArrow: { fontSize: 22, color: theme.ink, fontWeight: '600' },
  title: { fontFamily: 'Helvetica-Bold', fontSize: 26, color: theme.ink, marginBottom: 6 },
  subtitle: { fontSize: 14, color: theme.inkMuted, lineHeight: 20 },
  emailBold: { color: theme.ink, fontWeight: '700' },
  scrollView: { flex: 1 },
  scrollContent: { paddingHorizontal: 16, paddingBottom: 40 },
  formCard: {
    backgroundColor: theme.surface,
    borderRadius: 16,
    padding: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 2,
  },
  fieldContainer: { marginBottom: 20 },
  label: { fontSize: 13, color: theme.ink, fontWeight: '500', marginBottom: 6 },
  required: { color: theme.down },
  inputWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 56,
    borderWidth: 1.5,
    borderColor: theme.border,
    borderRadius: 12,
    paddingHorizontal: 16,
    backgroundColor: theme.surface,
  },
  inputFocused: { borderColor: theme.brand, backgroundColor: theme.surfaceRaised2, borderWidth: 2 },
  inputError: { borderColor: theme.down },
  fieldIcon: { fontSize: 18, marginRight: 10, opacity: 0.5 },
  input: { flex: 1, fontSize: 15, color: theme.ink, padding: 0 },
  codeInput: { letterSpacing: 6, fontWeight: '700' },
  validIcon: { fontSize: 18, color: theme.brand, fontWeight: '700', marginLeft: 8 },
  eyeButton: { padding: 4, marginLeft: 8 },
  eyeIcon: { fontSize: 18 },
  errorText: { fontSize: 11, color: theme.down, marginTop: 6, marginLeft: 4 },
  formError: { fontSize: 13, color: theme.down, marginTop: 4, textAlign: 'center' },
  strengthRow: { flexDirection: 'row', alignItems: 'center', marginTop: 10, marginLeft: 2 },
  strengthTrack: { flex: 1, height: 6, borderRadius: 3, backgroundColor: theme.surfaceRaised, overflow: 'hidden' },
  strengthFill: { height: 6, borderRadius: 3 },
  strengthLabel: { fontSize: 12, fontWeight: '700', marginLeft: 10, width: 52, textAlign: 'right' },
  primaryButton: {
    height: 56,
    backgroundColor: theme.brand,
    borderRadius: 14,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 4,
    marginBottom: 16,
  },
  primaryButtonDisabled: { opacity: 0.6 },
  primaryButtonText: { fontFamily: 'Helvetica-Bold', fontSize: 16, color: '#FFFFFF' },
  primaryButtonArrow: { fontSize: 18, color: '#FFFFFF', marginLeft: 8 },
  resendLink: { alignItems: 'center', marginTop: 4 },
  resendText: { fontSize: 14, color: theme.inkMuted },
  resendBold: { color: theme.brand, fontWeight: '700' },
  });
}
