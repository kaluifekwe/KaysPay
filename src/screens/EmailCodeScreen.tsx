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
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { emailVerificationService } from '../services/emailVerification.service';
import { safeErrorMessage } from '../utils/errorMessages';

const BRAND_GREEN = '#1A5C3A';
const DARK_TEXT = '#0F1A14';
const GRAY_TEXT = '#6B7280';
const BORDER_COLOR = '#E5E7EB';
const WHITE = '#FFFFFF';

export default function EmailCodeScreen(props: any) {
  const { navigation, route } = props;
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
      const result = await emailVerificationService.sendCode();
      if (!result.success) {
        setInitError(safeErrorMessage(result.error, 'Could not send verification code.'));
        return;
      }
      setResendTimer(59);
    } catch (error: any) {
      setInitError(safeErrorMessage(error, 'Could not send verification code.'));
    } finally {
      setInitializing(false);
    }
  };

  const handleCodeChange = (text: string, index: number) => {
    const digit = text.replace(/[^0-9]/g, '').slice(-1);
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
        Alert.alert('Verification Failed', safeErrorMessage(result.error, 'Invalid code. Please try again.'));
        setCode(['', '', '', '', '', '']);
        inputRefs.current[0]?.focus();
        return;
      }

      // Nothing to navigate to — RequireEmailVerifyNavigator's onComplete
      // swaps the whole root stack once this resolves.
      onVerified?.();
    } catch (error: any) {
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
              onPress={() => navigation.goBack()}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <Text style={styles.backArrow}>←</Text>
            </TouchableOpacity>
          )}

          <Text style={styles.title}>Verify Your Email</Text>

          {initializing ? (
            <View style={styles.initStateContainer}>
              <ActivityIndicator color={BRAND_GREEN} size="large" />
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
                  <ActivityIndicator color={WHITE} size="small" />
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

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: WHITE,
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
    color: DARK_TEXT,
  },
  initStateContainer: {
    alignItems: 'center',
    paddingTop: 40,
    gap: 20,
  },
  title: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 22,
    color: DARK_TEXT,
    marginBottom: 8,
    marginTop: 24,
  },
  subtitle: {
    fontSize: 14,
    color: GRAY_TEXT,
    marginBottom: 40,
    lineHeight: 20,
  },
  subtitleTight: {
    marginBottom: 14,
  },
  spamHint: {
    backgroundColor: '#F0F7F2',
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginBottom: 32,
  },
  spamHintText: {
    fontSize: 13,
    color: '#5b6b63',
    lineHeight: 19,
  },
  spamHintBold: {
    color: BRAND_GREEN,
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
    borderColor: BORDER_COLOR,
    borderRadius: 12,
    textAlign: 'center',
    fontSize: 24,
    fontWeight: '700',
    color: DARK_TEXT,
    backgroundColor: WHITE,
  },
  otpBoxFilled: {
    borderColor: BRAND_GREEN,
    backgroundColor: '#F9FAFB',
  },
  verifyButton: {
    height: 52,
    backgroundColor: BRAND_GREEN,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 24,
  },
  verifyButtonDisabled: {
    backgroundColor: '#9CA3AF',
  },
  verifyButtonText: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 16,
    color: WHITE,
  },
  verifyButtonTextDisabled: {
    color: '#D1D5DB',
  },
  resendContainer: {
    alignItems: 'center',
  },
  timerText: {
    fontSize: 14,
    color: GRAY_TEXT,
  },
  resendText: {
    fontSize: 14,
    color: BRAND_GREEN,
    fontWeight: '700',
  },
});
