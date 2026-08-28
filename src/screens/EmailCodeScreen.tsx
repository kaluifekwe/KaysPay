import React, { useState, useRef, useEffect } from 'react';
import {
  View,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  Alert,
  ActivityIndicator,
  Keyboard,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { emailVerificationService } from '../services/emailVerification.service';
import { safeErrorMessage } from '../utils/errorMessages';
import { storageHelpers } from '../lib/mmkv';
import { AppTheme } from '../constants/theme';
import { useTheme } from '../components/ThemeProvider';
import { analytics } from '../services/analytics.service';

const RESEND_COOLDOWN_MS = 60 * 1000;

function lastSentStorageKey(email: string): string {
  return `email_otp_last_sent_at:${email.trim().toLowerCase()}`;
}

export default function EmailCodeScreen(props: any) {
  const { navigation, route } = props;
  const { theme } = useTheme();
  const styles = createStyles(theme);
  const {
    target: email,
    onVerified,
  }: {
    /** The account's own email — this is always what the code was sent to,
     * since this screen only ever verifies the signup email itself. */
    target: string;
    /** Called after a correct code is verified. */
    onVerified?: () => void;
  } = route.params;
  const [code, setCode] = useState(['', '', '', '', '', '']);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [resendTimer, setResendTimer] = useState(0);
  // Nobody has sent a code before this screen mounts (unlike phone OTP,
  // where sendOTP always ran from the previous screen) — so this screen
  // sends the first one itself. `initError` covers the case where that
  // first send fails and there's nowhere to go back to (the mandatory
  // signup gate has no back route), so a retry has to live on this screen.
  const [initializing, setInitializing] = useState(true);
  const [initError, setInitError] = useState<string | null>(null);
  const inputRefs = useRef<(TextInput | null)[]>([]);

  useEffect(() => {
    void analytics.track('email_verification_started', { outcome: 'started', metadata: { verification_method: 'email_otp' } });
    sendInitialCode();
  }, []);

  useEffect(() => {
    if (resendTimer <= 0) return;
    const interval = setInterval(() => {
      setResendTimer((prev) => (prev <= 0 ? 0 : prev - 1));
    }, 1000);
    return () => clearInterval(interval);
  }, [resendTimer > 0]);

  const sendInitialCode = async () => {
    setInitializing(true);
    setInitError(null);
    try {
      // A cold app restart (very likely if Android kills the process while
      // the user switches away to check their email — exactly the target
      // device class here: older, lower-RAM phones) remounts this screen
      // from scratch. Auto-resending here would silently invalidate the
      // code already sitting in the user's inbox — verification only ever
      // checks the MOST RECENT unused code (see migration 040's
      // verify_email_verification_code) — with no indication to the user why
      // their code "stopped working." So this only ever auto-sends ONCE per
      // signup, the very first time this screen appears; on every later
      // mount (including after a cold restart), it just shows the entry
      // boxes and leaves getting a new code entirely up to the user tapping
      // Resend. A genuinely expired code fails verification with a clear
      // "This code has expired. Request a new one." message (see
      // verify-email-otp) — that's the intended way to recover, not a
      // silent auto-refresh.
      const key = lastSentStorageKey(email);
      const lastSentAt = await storageHelpers.getNumber(key);
      if (lastSentAt) {
        const elapsed = Date.now() - lastSentAt;
        setResendTimer(Math.max(0, Math.ceil((RESEND_COOLDOWN_MS - elapsed) / 1000)));
        return;
      }

      const result = await emailVerificationService.sendCode();
      if (!result.success) {
        void analytics.track('email_verification_failed', { outcome: 'failed', failureCode: 'code_send_failed', metadata: { verification_method: 'email_otp' } });
        setInitError(safeErrorMessage(result.error, 'Could not send verification code.'));
        return;
      }
      await storageHelpers.setNumber(key, Date.now());
      setResendTimer(59);
    } catch (error: any) {
      void analytics.track('email_verification_failed', { outcome: 'failed', failureCode: 'code_send_unavailable', metadata: { verification_method: 'email_otp' } });
      setInitError(safeErrorMessage(error, 'Could not send verification code.'));
    } finally {
      setInitializing(false);
    }
  };

  const handleCodeChange = (text: string, index: number) => {
    const digits = text.replace(/[^0-9]/g, '');

    // Pasting (or an OS autofill suggestion) drops the whole code into
    // whichever box was focused — spread it across all six instead of
    // truncating to just the last digit, so users can copy the code from
    // their email app instead of retyping it one digit at a time.
    if (digits.length > 1) {
      const newCode = [...code];
      let i = index;
      for (const d of digits) {
        if (i > 5) break;
        newCode[i] = d;
        i++;
      }
      setCode(newCode);
      inputRefs.current[Math.min(i, 5)]?.focus();
      return;
    }

    const digit = digits.slice(-1);
    const newCode = [...code];
    newCode[index] = digit;
    setCode(newCode);

    if (digit && index < 5) {
      inputRefs.current[index + 1]?.focus();
    }
  };

  const handleKeyPress = (key: string, index: number) => {
    if (key === 'Backspace' && !code[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
  };

  const handleVerify = async () => {
    const codeString = code.join('');
    if (codeString.length !== 6) {
      Alert.alert('Error', 'Please enter the complete 6-digit code');
      return;
    }

    setLoading(true);
    try {
      const result = await emailVerificationService.verifyCode(codeString);

      if (!result.success) {
        void analytics.track('email_verification_failed', { outcome: 'failed', failureCode: 'code_rejected', metadata: { verification_method: 'email_otp' } });
        Alert.alert('Verification Failed', safeErrorMessage(result.error, 'Invalid code. Please try again.'));
        setCode(['', '', '', '', '', '']);
        inputRefs.current[0]?.focus();
        return;
      }

      await storageHelpers.delete(lastSentStorageKey(email));
      void analytics.track('email_verified', { outcome: 'completed', metadata: { verification_method: 'email_otp' } });

      // Nothing to navigate to — RequireEmailVerifyNavigator's onComplete
      // swaps the whole root stack once this resolves.
      onVerified?.();
    } catch (error: any) {
      void analytics.track('email_verification_failed', { outcome: 'failed', failureCode: 'verification_unavailable', metadata: { verification_method: 'email_otp' } });
      Alert.alert('Verification Failed', safeErrorMessage(error, 'Invalid code. Please try again.'));
      setCode(['', '', '', '', '', '']);
      inputRefs.current[0]?.focus();
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    if (resendTimer > 0 || sending) return;

    setSending(true);
    try {
      const result = await emailVerificationService.sendCode();
      if (!result.success) {
        Alert.alert('Error', safeErrorMessage(result.error, 'Failed to resend code. Please try again.'));
        return;
      }
      await storageHelpers.setNumber(lastSentStorageKey(email), Date.now());
      setResendTimer(59);
      Alert.alert('Code Sent', 'A new verification code has been sent to your email.');
    } catch (error: any) {
      Alert.alert('Error', safeErrorMessage(error, 'Failed to resend code. Please try again.'));
    } finally {
      setSending(false);
    }
  };

  const formatTimer = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const maskedEmail = email.replace(/^(.{2}).*(@.*)$/, '$1***$2');
  const subtitle = `We sent a 6-digit code to ${maskedEmail}`;

  return (
    <SafeAreaView edges={['top']} style={styles.container}>
      <KeyboardAvoidingView
        style={styles.keyboardView}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.content}>
          {navigation.canGoBack() && (
            <TouchableOpacity
              style={styles.backButton}
              activeOpacity={0.6}
              onPress={() => { Keyboard.dismiss(); navigation.goBack(); }}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <Text style={styles.backArrow}>←</Text>
            </TouchableOpacity>
          )}

          <Text style={styles.title}>Verify Your Email</Text>

          {initializing ? (
            <View style={styles.initStateContainer}>
              <ActivityIndicator color={theme.brand} size="large" />
              <Text style={styles.subtitle}>Sending your verification code...</Text>
            </View>
          ) : initError ? (
            <View style={styles.initStateContainer}>
              <Text style={styles.subtitle}>{initError}</Text>
              <TouchableOpacity style={styles.verifyButton} onPress={sendInitialCode} activeOpacity={0.8}>
                <Text style={styles.verifyButtonText}>Try Again</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <>
              <Text style={[styles.subtitle, styles.subtitleTight]}>{subtitle}</Text>

              <View style={styles.spamHint}>
                <Text style={styles.spamHintText}>
                  Didn't get it? Check your <Text style={styles.spamHintBold}>Spam</Text> or{' '}
                  <Text style={styles.spamHintBold}>Promotions</Text> folder, then tap Resend.
                </Text>
              </View>

              <View style={styles.otpContainer}>
                {code.map((digit, index) => (
                  <TextInput
                    key={index}
                    ref={(ref) => { inputRefs.current[index] = ref; }}
                    style={[styles.otpBox, digit ? styles.otpBoxFilled : null]}
                    value={digit}
                    onChangeText={(text) => handleCodeChange(text, index)}
                    onKeyPress={({ nativeEvent }) => handleKeyPress(nativeEvent.key, index)}
                    keyboardType="number-pad"
                    maxLength={1}
                    autoFocus={index === 0}
                    selectTextOnFocus
                  />
                ))}
              </View>

              <TouchableOpacity
                style={[styles.verifyButton, code.join('').length !== 6 && styles.verifyButtonDisabled]}
                onPress={handleVerify}
                disabled={code.join('').length !== 6 || loading}
              >
                {loading ? (
                  <ActivityIndicator color="#FFFFFF" size="small" />
                ) : (
                  <Text style={[styles.verifyButtonText, code.join('').length !== 6 && styles.verifyButtonTextDisabled]}>
                    Verify
                  </Text>
                )}
              </TouchableOpacity>

              <View style={styles.resendContainer}>
                {resendTimer > 0 ? (
                  <Text style={styles.timerText}>Resend code in {formatTimer(resendTimer)}</Text>
                ) : (
                  <TouchableOpacity onPress={handleResend} disabled={sending}>
                    <Text style={styles.resendText}>{sending ? 'Sending...' : 'Resend Code'}</Text>
                  </TouchableOpacity>
                )}
              </View>
            </>
          )}
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.background,
  },
  keyboardView: {
    flex: 1,
  },
  content: {
    flex: 1,
    paddingHorizontal: 24,
    paddingTop: 16,
  },
  backButton: {
    width: 48,
    height: 48,
    justifyContent: 'center',
    alignItems: 'flex-start',
    marginBottom: 24,
  },
  backArrow: {
    fontSize: 24,
    color: theme.ink,
  },
  initStateContainer: {
    alignItems: 'center',
    paddingTop: 40,
    gap: 20,
  },
  title: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 22,
    color: theme.ink,
    marginBottom: 8,
    marginTop: 24,
  },
  subtitle: {
    fontSize: 14,
    color: theme.inkMuted,
    marginBottom: 40,
    lineHeight: 20,
  },
  subtitleTight: {
    marginBottom: 14,
  },
  spamHint: {
    backgroundColor: theme.brandSoft,
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginBottom: 32,
  },
  spamHintText: {
    fontSize: 13,
    color: theme.inkMuted,
    lineHeight: 19,
  },
  spamHintBold: {
    color: theme.brand,
    fontWeight: '700',
  },
  otpContainer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 40,
  },
  otpBox: {
    width: 48,
    height: 56,
    borderWidth: 1.5,
    borderColor: theme.border,
    borderRadius: 12,
    textAlign: 'center',
    fontSize: 24,
    fontWeight: '700',
    color: theme.ink,
    backgroundColor: theme.surface,
  },
  otpBoxFilled: {
    borderColor: theme.brand,
    backgroundColor: theme.surfaceRaised2,
  },
  verifyButton: {
    height: 52,
    backgroundColor: theme.brand,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 24,
  },
  verifyButtonDisabled: {
    backgroundColor: theme.inkFaint,
  },
  verifyButtonText: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 16,
    color: '#FFFFFF',
  },
  verifyButtonTextDisabled: {
    color: theme.inkFaint,
  },
  resendContainer: {
    alignItems: 'center',
  },
  timerText: {
    fontSize: 14,
    color: theme.inkMuted,
  },
  resendText: {
    fontSize: 14,
    color: theme.brand,
    fontWeight: '700',
  },
  });
}
