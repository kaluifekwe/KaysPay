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
  Keyboard,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AppTheme } from '../constants/theme';
import { useTheme } from '../components/ThemeProvider';
import { authService } from '../services/auth.service';

interface OTPVerifyScreenProps {
  navigation: any;
  route: any;
}

export default function OTPVerifyScreen({ navigation, route }: OTPVerifyScreenProps) {
  const { theme } = useTheme();
  const styles = createStyles(theme);
  const { phone, registrationData } = route.params || {};
  const [otp, setOtp] = useState(['', '', '', '', '', '']);
  const [loading, setLoading] = useState(false);
  const [resendTimer, setResendTimer] = useState(59);
  const inputRefs = useRef<(TextInput | null)[]>([]);

  useEffect(() => {
    const interval = setInterval(() => {
      setResendTimer((prev) => {
        if (prev <= 0) {
          clearInterval(interval);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, []);

  const handleOtpChange = (text: string, index: number) => {
    const digit = text.replace(/[^0-9]/g, '').slice(-1);
    const newOtp = [...otp];
    newOtp[index] = digit;
    setOtp(newOtp);

    if (digit && index < 5) {
      inputRefs.current[index + 1]?.focus();
    }
  };

  const handleKeyPress = (key: string, index: number) => {
    if (key === 'Backspace' && !otp[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
  };

  const handleVerify = async () => {
    const otpString = otp.join('');
    if (otpString.length !== 6) {
      Alert.alert('Error', 'Please enter the complete 6-digit code');
      return;
    }

    setLoading(true);
    try {
      const result = await authService.verifyOTP(phone, otpString);

      if (!result.success) {
        Alert.alert('Verification Failed', result.error || 'Invalid code. Please try again.');
        setOtp(['', '', '', '', '', '']);
        inputRefs.current[0]?.focus();
        return;
      }

      if (registrationData) {
        try {
          const { supabase } = await import('../lib/supabase');
          await supabase.auth.updateUser({
            data: {
              full_name: registrationData.full_name,
              email: registrationData.email,
              state: registrationData.state,
              address: registrationData.address,
              phone: registrationData.phone,
            },
          });
        } catch (e) {
          // silent - profile data save failed but OTP was valid
        }
      }

      // No manual navigation here — AppNavigator's root-level auth listener
      // detects the new session and swaps straight to the mandatory PIN
      // setup gate on its own (see RequirePinNavigator).
    } catch (error: any) {
      Alert.alert('Verification Failed', error.message || 'Invalid code. Please try again.');
      setOtp(['', '', '', '', '', '']);
      inputRefs.current[0]?.focus();
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    if (resendTimer > 0) return;

    try {
      const result = await authService.sendOTP(phone);

      if (!result.success) {
        Alert.alert('Error', result.error || 'Failed to resend code. Please try again.');
        return;
      }

      setResendTimer(59);
      Alert.alert('Code Sent', 'A new verification code has been sent to your phone.');
    } catch (error: any) {
      Alert.alert('Error', error.message || 'Failed to resend code. Please try again.');
    }
  };

  const formatTimer = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const maskedPhone = phone?.replace(/(\+234)(\d{3})(\d{4})(\d{4})/, '$1 $2 $3 $4') || '';

  return (
    <SafeAreaView edges={['top']} style={styles.container}>
      <KeyboardAvoidingView
        style={styles.keyboardView}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.content}>
          <TouchableOpacity
            style={styles.backButton}
            activeOpacity={0.6}
            onPress={() => { Keyboard.dismiss(); navigation.goBack(); }}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Text style={styles.backArrow}>←</Text>
          </TouchableOpacity>

          <Text style={styles.title}>Verify Your Number</Text>
          <Text style={styles.subtitle}>
            We sent a 6-digit code to {maskedPhone}
          </Text>

          <View style={styles.otpContainer}>
            {otp.map((digit, index) => (
              <TextInput
                key={index}
                ref={(ref) => { inputRefs.current[index] = ref; }}
                style={[
                  styles.otpBox,
                  digit ? styles.otpBoxFilled : null,
                ]}
                value={digit}
                onChangeText={(text) => handleOtpChange(text, index)}
                onKeyPress={({ nativeEvent }) => handleKeyPress(nativeEvent.key, index)}
                keyboardType="number-pad"
                maxLength={1}
                autoFocus={index === 0}
                selectTextOnFocus
              />
            ))}
          </View>

          <TouchableOpacity
            style={[styles.verifyButton, otp.join('').length !== 6 && styles.verifyButtonDisabled]}
            onPress={handleVerify}
            disabled={otp.join('').length !== 6 || loading}
          >
            <Text style={[styles.verifyButtonText, otp.join('').length !== 6 && styles.verifyButtonTextDisabled]}>
              {loading ? 'Verifying...' : 'Verify'}
            </Text>
          </TouchableOpacity>

          <View style={styles.resendContainer}>
            {resendTimer > 0 ? (
              <Text style={styles.timerText}>
                Resend code in {formatTimer(resendTimer)}
              </Text>
            ) : (
              <TouchableOpacity onPress={handleResend}>
                <Text style={styles.resendText}>Resend OTP</Text>
              </TouchableOpacity>
            )}
          </View>
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
  title: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 22,
    color: theme.ink,
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 14,
    color: theme.inkMuted,
    marginBottom: 40,
    lineHeight: 20,
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
    backgroundColor: theme.surfaceRaised,
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
    color: 'rgba(255,255,255,0.7)',
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
