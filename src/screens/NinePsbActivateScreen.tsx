import React, { useState, useRef } from 'react';
import {
  View,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  Alert,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { AppTheme } from '../constants/theme';
import { useTheme } from '../components/ThemeProvider';
import { Typography } from '../constants/typography';
import { Spacing } from '../constants/spacing';
import { virtualAccountService } from '../services/virtualAccount.service';
import { analytics } from '../services/analytics.service';

// Finishes 9PSB wallet setup's Call 2 (identity/verify-otp -> open_wallet,
// both server-side inside create-virtual-account -- see the approved 9PSB
// WAAS plan's Deployment constraints, preview channel + closed testing
// track only). Reached two ways: right after KYC completes (Call 1 already
// ran automatically, server-side), or from the Home screen's "activate
// your account number" banner for a backfilled existing customer -- both
// land here with the same transactionRef param, no branching needed.

interface NinePsbActivateScreenProps {
  navigation: { goBack: () => void; navigate: (screen: string, params?: any) => void };
  route: { params: { transactionRef: string } };
}

export default function NinePsbActivateScreen({ navigation, route }: NinePsbActivateScreenProps) {
  const { theme } = useTheme();
  const styles = createStyles(theme);
  const { transactionRef } = route.params;

  const [otp, setOtp] = useState(['', '', '', '', '', '']);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [account, setAccount] = useState<{ account_number: string; bank_name: string; account_name: string } | null>(null);
  const otpRefs = useRef<(TextInput | null)[]>([]);

  const otpString = otp.join('');
  const isOtpValid = otpString.length === 6;

  const handleDigitChange = (text: string, index: number) => {
    const digit = text.replace(/[^0-9]/g, '').slice(-1);
    const next = [...otp];
    next[index] = digit;
    setOtp(next);
    setError('');
    if (digit && index < 5) otpRefs.current[index + 1]?.focus();
  };

  const handleKeyPress = (key: string, index: number) => {
    if (key === 'Backspace' && !otp[index] && index > 0) otpRefs.current[index - 1]?.focus();
  };

  const handleVerify = async () => {
    if (!isOtpValid || submitting) return;
    setSubmitting(true);
    setError('');
    void analytics.track('funding_started', { outcome: 'started', metadata: { funding_method: '9psb' } });
    const result = await virtualAccountService.verifyNinePsbOtp(transactionRef, otpString);
    setSubmitting(false);
    if (!result.success || !result.account) {
      setError(result.error || 'That code didn’t work. Please try again.');
      return;
    }
    setAccount(result.account);
  };

  if (account) {
    return (
      <SafeAreaView edges={['top']} style={styles.container}>
        <View style={styles.successBody}>
          <View style={styles.successIconWrap}>
            <Ionicons name="checkmark-circle" size={56} color={theme.brand} />
          </View>
          <Text style={styles.successTitle}>Your 9PSB account is ready</Text>
          <Text style={styles.successSubtitle}>
            Transfer to this account any time to fund your wallet automatically.
          </Text>
          <View style={styles.accountCard}>
            <Text style={styles.accountNumber} selectable>{account.account_number}</Text>
            <Text style={styles.accountMeta}>{account.bank_name}</Text>
            <Text style={styles.accountMeta}>{account.account_name}</Text>
          </View>
          <TouchableOpacity style={styles.primaryButton} onPress={() => navigation.navigate('HomeTabs')}>
            <Text style={styles.primaryButtonText}>Done</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView edges={['top']} style={styles.container}>
      <KeyboardAvoidingView style={styles.keyboardView} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.header}>
          <TouchableOpacity style={styles.backButton} onPress={() => navigation.goBack()} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Ionicons name="chevron-back" size={22} color={theme.ink} />
          </TouchableOpacity>
          <Text style={styles.title}>Activate 9PSB wallet</Text>
        </View>

        <View style={styles.body}>
          <View style={styles.iconWrap}>
            <Ionicons name="shield-checkmark-outline" size={28} color={theme.brand} />
          </View>
          <Text style={styles.heading}>Verify it's you</Text>
          <Text style={styles.subtitle}>
            9PSB sent a 6-digit code to the phone number linked to your BVN or NIN.
          </Text>

          <View style={styles.otpRow}>
            {otp.map((digit, index) => (
              <TextInput
                key={index}
                ref={(ref) => { otpRefs.current[index] = ref; }}
                style={[styles.otpBox, digit ? styles.otpBoxFilled : null, error ? styles.otpBoxError : null]}
                value={digit}
                onChangeText={(text) => handleDigitChange(text, index)}
                onKeyPress={({ nativeEvent }) => handleKeyPress(nativeEvent.key, index)}
                keyboardType="number-pad"
                maxLength={1}
                secureTextEntry
              />
            ))}
          </View>
          {!!error && <Text style={styles.errorText}>{error}</Text>}

          <TouchableOpacity
            style={[styles.primaryButton, (!isOtpValid || submitting) && styles.primaryButtonDisabled]}
            onPress={handleVerify}
            disabled={!isOtpValid || submitting}
          >
            <Text style={styles.primaryButtonText}>{submitting ? 'Verifying…' : 'Verify code'}</Text>
          </TouchableOpacity>

          <TouchableOpacity
            onPress={() => Alert.alert('Didn’t get a code?', 'Please go back and try setting up your 9PSB wallet again in a few minutes.')}
          >
            <Text style={styles.resendText}>Didn't get a code?</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.background },
    keyboardView: { flex: 1 },
    header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingTop: 12, paddingBottom: 8 },
    backButton: {
      width: 40, height: 40, borderRadius: 20, backgroundColor: theme.surfaceRaised,
      justifyContent: 'center', alignItems: 'center', marginRight: 12,
    },
    title: { fontFamily: 'Helvetica-Bold', fontSize: 17, color: theme.ink },
    body: { flex: 1, paddingHorizontal: 24, paddingTop: 24, alignItems: 'center' },
    iconWrap: {
      width: 56, height: 56, borderRadius: 28, backgroundColor: theme.surfaceRaised2,
      justifyContent: 'center', alignItems: 'center', marginBottom: 16,
    },
    heading: { ...Typography.HEADING, color: theme.ink, marginBottom: 8, textAlign: 'center' },
    subtitle: { ...Typography.BODY, color: theme.inkMuted, textAlign: 'center', marginBottom: 28, paddingHorizontal: 8 },
    otpRow: { flexDirection: 'row', gap: 8, marginBottom: 12 },
    otpBox: {
      width: 44, height: 52, borderWidth: 1.5, borderColor: theme.border, borderRadius: 10,
      textAlign: 'center', fontSize: 20, fontFamily: 'Helvetica-Bold', backgroundColor: theme.surface, color: theme.ink,
    },
    otpBoxFilled: { borderColor: theme.brand, backgroundColor: theme.surfaceRaised2 },
    otpBoxError: { borderColor: theme.down },
    errorText: { fontSize: 12, color: theme.down, marginBottom: 16, textAlign: 'center' },
    primaryButton: {
      width: '100%', height: 52, backgroundColor: theme.brand, borderRadius: 12,
      justifyContent: 'center', alignItems: 'center', marginTop: Spacing.M,
    },
    primaryButtonDisabled: { opacity: 0.5 },
    primaryButtonText: { ...Typography.BUTTON_TEXT, color: '#FFFFFF' },
    resendText: { ...Typography.CAPTION, color: theme.brand, marginTop: 16, textDecorationLine: 'underline' },
    successBody: { flex: 1, paddingHorizontal: 24, paddingTop: 60, alignItems: 'center' },
    successIconWrap: { marginBottom: 16 },
    successTitle: { ...Typography.HEADING, color: theme.ink, textAlign: 'center', marginBottom: 8 },
    successSubtitle: { ...Typography.BODY, color: theme.inkMuted, textAlign: 'center', marginBottom: 24, paddingHorizontal: 8 },
    accountCard: {
      width: '100%', backgroundColor: theme.surfaceRaised, borderRadius: 14, padding: 18,
      alignItems: 'center', marginBottom: 28,
    },
    accountNumber: { fontFamily: 'Helvetica-Bold', fontSize: 22, color: theme.brand, letterSpacing: 1, marginBottom: 6 },
    accountMeta: { ...Typography.CAPTION, color: theme.inkMuted },
  });
}
