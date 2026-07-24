import React, { useState } from 'react';
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

interface Props {
  navigation: any;
}

export default function ForgotPasswordScreen({ navigation }: Props) {
  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState('');
  const [focused, setFocused] = useState(false);
  const [loading, setLoading] = useState(false);

  const validate = (value: string) => {
    if (!value.trim()) {
      setEmailError('');
      return false;
    }
    const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
    setEmailError(ok ? '' : 'Please enter a valid email address');
    return ok;
  };

  const isValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

  const handleSend = async () => {
    if (!validate(email)) return;
    setLoading(true);
    try {
      const result = await authService.requestPasswordReset(email);
      if (!result.success) {
        Alert.alert('Something went wrong', result.error || 'Please try again.');
        return;
      }
      // The server never reveals whether the account exists, so we always move
      // on to the code screen and let the user enter whatever code they get.
      navigation.navigate('ResetPassword', { email: email.trim().toLowerCase() });
    } catch (error: any) {
      Alert.alert('Something went wrong', error.message || 'Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <KeyboardAvoidingView
        style={styles.keyboardView}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <View style={styles.header}>
          <TouchableOpacity
            style={styles.backButton}
            activeOpacity={0.7}
            onPress={() => navigation.goBack()}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Text style={styles.backArrow}>‹</Text>
          </TouchableOpacity>
          <Text style={styles.title}>Forgot Password?</Text>
          <Text style={styles.subtitle}>
            Enter the email on your account and we'll send you a 6-digit code to reset your password.
          </Text>
        </View>

        <ScrollView
          style={styles.scrollView}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.formCard}>
            <View style={styles.fieldContainer}>
              <Text style={styles.label}>
                Email Address<Text style={styles.required}> *</Text>
              </Text>
              <View style={[styles.inputWrapper, emailError ? styles.inputError : focused ? styles.inputFocused : null]}>
                <Text style={styles.fieldIcon}>✉</Text>
                <TextInput
                  style={styles.input}
                  placeholder="example@gmail.com"
                  placeholderTextColor="#9CA3AF"
                  value={email}
                  onChangeText={(t) => {
                    setEmail(t);
                    validate(t);
                  }}
                  onFocus={() => setFocused(true)}
                  onBlur={() => setFocused(false)}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoCorrect={false}
                  returnKeyType="send"
                  onSubmitEditing={handleSend}
                />
                {email.length > 0 && !emailError && <Text style={styles.validIcon}>✓</Text>}
              </View>
              {emailError ? <Text style={styles.errorText}>{emailError}</Text> : null}
            </View>
          </View>

          <TouchableOpacity
            style={[styles.primaryButton, (!isValid || loading) && styles.primaryButtonDisabled]}
            onPress={handleSend}
            disabled={!isValid || loading}
            activeOpacity={0.8}
          >
            <Text style={styles.primaryButtonText}>{loading ? 'Sending...' : 'Send reset code'}</Text>
            {!loading && <Text style={styles.primaryButtonArrow}>→</Text>}
          </TouchableOpacity>

          <TouchableOpacity style={styles.backLink} onPress={() => navigation.navigate('Login')} activeOpacity={0.7}>
            <Text style={styles.backLinkText}>
              Remembered it? <Text style={styles.backLinkBold}>Back to Login</Text>
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
  fieldContainer: { marginBottom: 4 },
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
  validIcon: { fontSize: 18, color: BRAND_GREEN, fontWeight: '700', marginLeft: 8 },
  errorText: { fontSize: 11, color: ERROR_RED, marginTop: 6, marginLeft: 4 },
  primaryButton: {
    height: 56,
    backgroundColor: BRAND_GREEN,
    borderRadius: 14,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 20,
    marginBottom: 16,
  },
  primaryButtonDisabled: { opacity: 0.6 },
  primaryButtonText: { fontFamily: 'Helvetica-Bold', fontSize: 16, color: WHITE },
  primaryButtonArrow: { fontSize: 18, color: WHITE, marginLeft: 8 },
  backLink: { alignItems: 'center', marginTop: 4 },
  backLinkText: { fontSize: 14, color: GRAY_TEXT },
  backLinkBold: { color: BRAND_GREEN, fontWeight: '700' },
});
