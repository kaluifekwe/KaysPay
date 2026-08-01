import React, { useState, useRef, useEffect } from 'react';
import {
  View,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Animated,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { authService } from '../services/auth.service';
import { supabase } from '../lib/supabase';
import { MIN_PASSWORD_LENGTH, passwordValidationError } from '../utils/password';

const BRAND_GREEN = '#1A5C3A';
const DARK_TEXT = '#0F1A14';
const GRAY_TEXT = '#6B7280';
const LABEL_COLOR = '#374151';
const BORDER_COLOR = '#E5E7EB';
const ERROR_RED = '#DC2626';
const WHITE = '#FFFFFF';
const SCREEN_BG = '#F8FAF9';
const INPUT_BG = '#FFFFFF';
const FOCUS_BG = '#FAFFFE';
const BACK_BTN_BG = '#F3F4F6';

const NIGERIAN_PREFIXES = [
  '0703', '0706', '0802', '0803', '0805', '0806', '0807', '0808', '0809', '0810',
  '0811', '0812', '0813', '0814', '0815', '0816', '0817', '0818', '0902', '0903',
  '0905', '0906', '0907', '0908', '0909', '0915',
];

const NETWORK_CONFIG: Record<string, { name: string; bg: string; color: string }> = {
  MTN: { name: 'MTN', bg: '#FFF9E6', color: '#B8860B' },
  Airtel: { name: 'Airtel', bg: '#FFF0F0', color: '#ED1C24' },
  Glo: { name: 'Glo', bg: '#F0FFF4', color: '#006633' },
  '9mobile': { name: '9mobile', bg: '#F0FFF8', color: '#006A4E' },
};

const NETWORK_MAP: Record<string, string> = {
  '0703': 'MTN', '0706': 'MTN', '0803': 'MTN', '0806': 'MTN', '0810': 'MTN',
  '0813': 'MTN', '0814': 'MTN', '0816': 'MTN', '0903': 'MTN', '0906': 'MTN',
  '0802': 'Airtel', '0807': 'Airtel', '0808': 'Airtel',
  '0811': 'Airtel', '0812': 'Airtel', '0902': 'Airtel', '0907': 'Airtel',
  '0809': '9mobile', '0815': '9mobile', '0817': '9mobile', '0818': '9mobile',
  '0908': '9mobile', '0909': '9mobile',
  '0705': 'Glo', '0805': 'Glo', '0905': 'Glo',
};

function detectNetwork(phone: string): string | null {
  const prefix = phone.substring(0, 4);
  return NETWORK_MAP[prefix] || null;
}

// Lightweight strength signal — rewards length + character variety. Purely
// advisory (we still only *require* 6+ chars); it nudges users toward a
// stronger password without blocking a valid one.
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

const Icons = {
  user: '👤',
  mail: '✉',
  phone: '📱',
  arrowRight: '→',
  back: '‹',
};

interface RegistrationScreenProps {
  navigation: any;
}

export default function RegistrationScreen({ navigation }: RegistrationScreenProps) {
  const [step, setStep] = useState<1 | 2>(1);

  // Step 1
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [fullNameError, setFullNameError] = useState('');
  const [emailError, setEmailError] = useState('');
  const [phoneError, setPhoneError] = useState('');
  const [fullNameValid, setFullNameValid] = useState(false);
  const [emailValid, setEmailValid] = useState(false);
  const [phoneValid, setPhoneValid] = useState(true); // phone is optional
  const [detectedNetwork, setDetectedNetwork] = useState<string | null>(null);

  // Step 2
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [pin, setPin] = useState(['', '', '', '']);
  const [confirmPin, setConfirmPin] = useState(['', '', '', '']);
  const [passwordError, setPasswordError] = useState('');
  const [confirmPasswordError, setConfirmPasswordError] = useState('');
  const [pinError, setPinError] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [focusedField, setFocusedField] = useState<string | null>(null);

  const buttonScale = useRef(new Animated.Value(1)).current;
  const networkAnim = useRef(new Animated.Value(0)).current;

  const emailRef = useRef<TextInput>(null);
  const phoneRef = useRef<TextInput>(null);
  const confirmPasswordRef = useRef<TextInput>(null);
  const scrollRef = useRef<ScrollView>(null);
  const pinRefs = useRef<(TextInput | null)[]>([]);
  const confirmPinRefs = useRef<(TextInput | null)[]>([]);

  useEffect(() => {
    validateFullName(fullName);
    validateEmail(email);
    validatePhone(phone);
  }, [fullName, email, phone]);

  useEffect(() => {
    if (detectedNetwork) {
      Animated.spring(networkAnim, { toValue: 1, useNativeDriver: true, tension: 50, friction: 7 }).start();
    } else {
      networkAnim.setValue(0);
    }
  }, [detectedNetwork]);

  useEffect(() => {
    if (!password) {
      setPasswordError('');
    } else if (passwordValidationError(password)) {
      setPasswordError(passwordValidationError(password) || 'Password is too short');
    } else {
      setPasswordError('');
    }
    if (confirmPassword && confirmPassword !== password) {
      setConfirmPasswordError('Passwords do not match');
    } else {
      setConfirmPasswordError('');
    }
  }, [password, confirmPassword]);

  const validateFullName = (value: string) => {
    if (!value.trim()) {
      setFullNameError('');
      setFullNameValid(false);
      return;
    }
    const words = value.trim().split(/\s+/);
    const hasNumbers = /\d/.test(value);
    if (words.length < 2 || hasNumbers) {
      setFullNameError('Please enter your full name (first and last)');
      setFullNameValid(false);
      return;
    }
    setFullNameError('');
    setFullNameValid(true);
  };

  const validateEmail = (value: string) => {
    if (!value.trim()) {
      setEmailError('');
      setEmailValid(false);
      return;
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(value)) {
      setEmailError('Please enter a valid email address');
      setEmailValid(false);
      return;
    }
    setEmailError('');
    setEmailValid(true);
  };

  // Phone is optional (the app serves users outside Nigeria too) — only
  // validate format when something is entered.
  const validatePhone = (value: string) => {
    if (!value.trim()) {
      setPhoneError('');
      setPhoneValid(true);
      setDetectedNetwork(null);
      return;
    }
    const cleanPhone = value.replace(/\s/g, '');
    if (cleanPhone.length < 7 || cleanPhone.length > 15) {
      setPhoneError('Please enter a valid phone number');
      setPhoneValid(false);
      setDetectedNetwork(null);
      return;
    }
    let isNigerianPrefix = false;
    if (cleanPhone.startsWith('0') && cleanPhone.length === 11) {
      isNigerianPrefix = NIGERIAN_PREFIXES.includes(cleanPhone.substring(0, 4));
    } else if (!cleanPhone.startsWith('0') && cleanPhone.length === 10) {
      isNigerianPrefix = NIGERIAN_PREFIXES.includes('0' + cleanPhone.substring(0, 3));
    }
    setPhoneError('');
    setPhoneValid(true);
    setDetectedNetwork(isNigerianPrefix ? detectNetwork(cleanPhone) : null);
  };

  const isStep1Valid = fullNameValid && emailValid && phoneValid;

  const pinString = pin.join('');
  const confirmPinString = confirmPin.join('');
  const isPinValid = pinString.length === 4;
  const isConfirmPinValid = isPinValid && confirmPinString === pinString;
  const isStep2Valid =
    !passwordError && password.length >= MIN_PASSWORD_LENGTH &&
    !confirmPasswordError && confirmPassword.length > 0 &&
    isPinValid && isConfirmPinValid;

  const handlePhoneChange = (text: string) => {
    const cleaned = text.replace(/[^0-9]/g, '');
    if (cleaned.length <= 15) setPhone(cleaned);
  };

  const handleNext = () => {
    if (!isStep1Valid) return;
    setStep(2);
  };

  const handlePinDigitChange = (
    text: string,
    index: number,
    values: string[],
    setValues: (v: string[]) => void,
    refs: React.MutableRefObject<(TextInput | null)[]>,
  ) => {
    const digit = text.replace(/[^0-9]/g, '').slice(-1);
    const next = [...values];
    next[index] = digit;
    setValues(next);
    setPinError('');
    if (digit && index < 3) refs.current[index + 1]?.focus();
  };

  const handlePinKeyPress = (
    key: string,
    index: number,
    values: string[],
    refs: React.MutableRefObject<(TextInput | null)[]>,
  ) => {
    if (key === 'Backspace' && !values[index] && index > 0) refs.current[index - 1]?.focus();
  };

  const handleCreateAccount = async () => {
    if (!isStep2Valid || submitting) return;

    if (confirmPinString !== pinString) {
      setPinError('PINs do not match');
      return;
    }

    Animated.sequence([
      Animated.timing(buttonScale, { toValue: 0.97, duration: 100, useNativeDriver: true }),
      Animated.timing(buttonScale, { toValue: 1, duration: 100, useNativeDriver: true }),
    ]).start();

    let formattedPhone = phone.trim();
    if (formattedPhone) {
      if (formattedPhone.startsWith('0') && formattedPhone.length === 11) {
        formattedPhone = '+234' + formattedPhone.substring(1);
      } else if (!formattedPhone.startsWith('+')) {
        formattedPhone = '+' + formattedPhone;
      }
    }

    setSubmitting(true);
    try {
      const result = await authService.signUpWithEmail(email.trim().toLowerCase(), password, {
        full_name: fullName.trim(),
        phone: formattedPhone || null,
      });

      if (!result.success) {
        Alert.alert('Sign Up Failed', result.error || 'Something went wrong. Please try again.');
        return;
      }

      if (result.needsEmailConfirmation) {
        // Shouldn't normally happen once "Confirm email" is off in Supabase,
        // but kept as a safe fallback in case it's ever re-enabled.
        Alert.alert(
          'Check Your Email',
          'Please confirm your email address before continuing, then log in.',
          [{ text: 'OK', onPress: () => navigation.replace('Login') }],
        );
        return;
      }

      // Stash the PIN first so it can be saved reliably after email
      // verification even if every immediate attempt below fails — this is the
      // guarantee that the user is never asked to create a PIN again (see
      // authService.ensurePinSaved, called from AppNavigator once the session
      // is fully established).
      await authService.stashSignupPin(pinString);

      // Best-effort immediate save so the PIN is usually persisted before email
      // verify even completes. Root cause of the redundant PIN gate: right after
      // signUp the new access token isn't yet attached to database calls, so
      // set_user_pin runs with no authenticated user (auth.uid() is null) and
      // fails. Forcing the session to materialize first (refreshSession) helps,
      // but the stash above is what actually guarantees it.
      try {
        await supabase.auth.refreshSession();
      } catch {
        // ignore — the stash + ensurePinSaved after email verify still guard it
      }
      let pinSaved = false;
      let lastPinError: string | undefined;
      for (let attempt = 0; attempt < 4 && !pinSaved; attempt++) {
        const pinResult = await authService.savePIN(pinString);
        pinSaved = pinResult.success;
        lastPinError = pinResult.error;
        if (!pinSaved && attempt < 3) {
          await new Promise((r) => setTimeout(r, 700));
        }
      }
      if (!pinSaved) {
        // Surfaces the true reason in logs if it ever still fails, instead of
        // silently dropping the user onto the PIN gate.
        console.warn('Signup: PIN save failed after retries:', lastPinError);
      }

      // No manual navigation — AppNavigator's root-level auth listener
      // detects the new session and swaps to the email-verify gate on its
      // own (see RequireEmailVerifyNavigator).
    } catch (error: any) {
      Alert.alert('Sign Up Failed', error.message || 'Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const getFieldStyle = (hasError: boolean, isValid: boolean, isFocused: boolean) => {
    if (hasError) return styles.inputError;
    if (isFocused) return styles.inputFocused;
    if (isValid) return styles.inputValid;
    return null;
  };

  const renderFieldIcon = (icon: string) => <Text style={styles.fieldIcon}>{icon}</Text>;

  const renderStatusIcon = (hasError: boolean, isValid: boolean) => {
    if (hasError) return <Text style={styles.errorIcon}>×</Text>;
    if (isValid) return <Text style={styles.validIcon}>✓</Text>;
    return null;
  };

  const renderError = (error: string) => (error ? <Text style={styles.errorText}>{error}</Text> : null);

  const renderLabel = (label: string, required: boolean = true) => (
    <Text style={styles.label}>
      {label}
      {required && <Text style={styles.required}> *</Text>}
    </Text>
  );

  const renderPinRow = (
    values: string[],
    setValues: (v: string[]) => void,
    refs: React.MutableRefObject<(TextInput | null)[]>,
  ) => (
    <View style={styles.pinContainer}>
      {values.map((digit, index) => (
        <TextInput
          key={index}
          ref={(ref) => { refs.current[index] = ref; }}
          style={[styles.pinBox, digit ? styles.pinBoxFilled : null]}
          value={digit}
          onChangeText={(text) => handlePinDigitChange(text, index, values, setValues, refs)}
          onKeyPress={({ nativeEvent }) => handlePinKeyPress(nativeEvent.key, index, values, refs)}
          keyboardType="number-pad"
          maxLength={1}
          secureTextEntry
        />
      ))}
    </View>
  );

  return (
    <SafeAreaView edges={['top']} style={styles.container}>
      <KeyboardAvoidingView style={styles.keyboardView} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <View style={styles.header}>
          <TouchableOpacity
            style={styles.backButton}
            activeOpacity={0.7}
            onPress={() => (step === 2 ? setStep(1) : navigation.goBack())}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Text style={styles.backArrow}>{Icons.back}</Text>
          </TouchableOpacity>
          <Text style={styles.title}>Create Account</Text>
          <Text style={styles.subtitle}>
            {step === 1 ? 'Fill in your details to get started' : 'Set a password and transaction PIN'}
          </Text>

          <View style={styles.progressContainer}>
            <View style={styles.progressLabelRow}>
              <Text style={styles.progressLabel}>
                {step === 1 ? 'Step 1 of 2 — Personal Details' : 'Step 2 of 2 — Security'}
              </Text>
            </View>
            <View style={styles.progressBar}>
              <View style={[styles.progressFill, { width: step === 1 ? '50%' : '100%' }]} />
            </View>
          </View>
        </View>

        <ScrollView
          ref={scrollRef}
          style={styles.scrollView}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {step === 1 ? (
            <View style={styles.formCard}>
              <View style={styles.fieldContainer}>
                {renderLabel('Full Name')}
                <View style={[styles.inputWrapper, getFieldStyle(!!fullNameError, fullNameValid, focusedField === 'fullName')]}>
                  {renderFieldIcon(Icons.user)}
                  <TextInput
                    style={styles.input}
                    placeholder="e.g. Amina Bello"
                    placeholderTextColor="#9CA3AF"
                    value={fullName}
                    onChangeText={setFullName}
                    onFocus={() => setFocusedField('fullName')}
                    onBlur={() => setFocusedField(null)}
                    autoCapitalize="words"
                    autoCorrect={false}
                  />
                  {renderStatusIcon(!!fullNameError, fullNameValid)}
                </View>
                {renderError(fullNameError)}
              </View>

              <View style={styles.fieldContainer}>
                {renderLabel('Email Address')}
                <View style={[styles.inputWrapper, getFieldStyle(!!emailError, emailValid, focusedField === 'email')]}>
                  {renderFieldIcon(Icons.mail)}
                  <TextInput
                    ref={emailRef}
                    style={styles.input}
                    placeholder="example@gmail.com"
                    placeholderTextColor="#9CA3AF"
                    value={email}
                    onChangeText={setEmail}
                    onFocus={() => setFocusedField('email')}
                    onBlur={() => setFocusedField(null)}
                    keyboardType="email-address"
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                  {renderStatusIcon(!!emailError, emailValid)}
                </View>
                {renderError(emailError)}
                <Text style={styles.hintText}>This can't be changed later, so make sure it's correct.</Text>
              </View>

              <View style={styles.fieldContainer}>
                {renderLabel('Phone Number', false)}
                <View style={[styles.inputWrapper, getFieldStyle(!!phoneError, phoneValid, focusedField === 'phone')]}>
                  {renderFieldIcon(Icons.phone)}
                  <TextInput
                    ref={phoneRef}
                    style={styles.input}
                    placeholder="e.g. 0803 123 4567 or +1 415 555 2671"
                    placeholderTextColor="#9CA3AF"
                    value={phone}
                    onChangeText={handlePhoneChange}
                    onFocus={() => setFocusedField('phone')}
                    onBlur={() => setFocusedField(null)}
                    keyboardType="numeric"
                    maxLength={15}
                  />
                  {renderStatusIcon(!!phoneError, phoneValid && phone.length > 0)}
                </View>
                {detectedNetwork && phoneValid && (
                  <Animated.View style={[styles.networkBadge, { opacity: networkAnim, transform: [{ translateY: networkAnim.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) }] }]}>
                    <View style={[styles.networkDot, { backgroundColor: NETWORK_CONFIG[detectedNetwork]?.color }]} />
                    <Text style={[styles.networkText, { color: NETWORK_CONFIG[detectedNetwork]?.color }]}>
                      {detectedNetwork} detected ✓
                    </Text>
                  </Animated.View>
                )}
                {phone.length > 0 && renderError(phoneError)}
              </View>

              <TouchableOpacity
                style={[styles.createButton, !isStep1Valid && styles.createButtonDisabled]}
                onPress={handleNext}
                disabled={!isStep1Valid}
                activeOpacity={0.8}
              >
                <Text style={styles.createButtonText}>Next</Text>
                <Text style={styles.createButtonArrow}>{Icons.arrowRight}</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View style={styles.formCard}>
              <View style={styles.fieldContainer}>
                {renderLabel('Password')}
                <View style={[styles.inputWrapper, getFieldStyle(!!passwordError, password.length >= MIN_PASSWORD_LENGTH, focusedField === 'password')]}>
                  <Text style={styles.fieldIcon}>🔒</Text>
                  <TextInput
                    style={styles.input}
                    placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
                    placeholderTextColor="#9CA3AF"
                    value={password}
                    onChangeText={setPassword}
                    onFocus={() => setFocusedField('password')}
                    onBlur={() => setFocusedField(null)}
                    secureTextEntry={!showPassword}
                    autoCapitalize="none"
                    autoCorrect={false}
                    returnKeyType="next"
                    onSubmitEditing={() => confirmPasswordRef.current?.focus()}
                  />
                  <TouchableOpacity onPress={() => setShowPassword((v) => !v)} activeOpacity={0.7}>
                    <Text style={styles.fieldIcon}>{showPassword ? '🙈' : '👁'}</Text>
                  </TouchableOpacity>
                  {renderStatusIcon(!!passwordError, password.length >= MIN_PASSWORD_LENGTH)}
                </View>
                {renderError(passwordError)}
                {password.length > 0 && (
                  <View style={styles.strengthRow}>
                    <View style={styles.strengthTrack}>
                      <View
                        style={[
                          styles.strengthFill,
                          { width: `${passwordStrength(password).pct}%`, backgroundColor: passwordStrength(password).color },
                        ]}
                      />
                    </View>
                    <Text style={[styles.strengthLabel, { color: passwordStrength(password).color }]}>
                      {passwordStrength(password).label}
                    </Text>
                  </View>
                )}
              </View>

              <View style={styles.fieldContainer}>
                {renderLabel('Confirm Password')}
                <View style={[styles.inputWrapper, getFieldStyle(!!confirmPasswordError, confirmPassword.length > 0 && !confirmPasswordError, focusedField === 'confirmPassword')]}>
                  <Text style={styles.fieldIcon}>🔒</Text>
                  <TextInput
                    ref={confirmPasswordRef}
                    style={styles.input}
                    placeholder="Re-enter your password"
                    placeholderTextColor="#9CA3AF"
                    value={confirmPassword}
                    onChangeText={setConfirmPassword}
                    onFocus={() => setFocusedField('confirmPassword')}
                    onBlur={() => setFocusedField(null)}
                    secureTextEntry={!showConfirmPassword}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                  <TouchableOpacity onPress={() => setShowConfirmPassword((v) => !v)} activeOpacity={0.7}>
                    <Text style={styles.fieldIcon}>{showConfirmPassword ? '🙈' : '👁'}</Text>
                  </TouchableOpacity>
                  {renderStatusIcon(!!confirmPasswordError, confirmPassword.length > 0 && !confirmPasswordError)}
                </View>
                {renderError(confirmPasswordError)}
              </View>

              <View style={styles.fieldContainer}>
                {renderLabel('Transaction PIN (4 digits)')}
                <Text style={styles.hintText}>Used to authorize every payment you make in the app.</Text>
                {renderPinRow(pin, setPin, pinRefs)}
              </View>

              <View style={styles.fieldContainer}>
                {renderLabel('Confirm PIN')}
                {renderPinRow(confirmPin, setConfirmPin, confirmPinRefs)}
                {renderError(pinError)}
              </View>

              <Animated.View style={{ transform: [{ scale: buttonScale }] }}>
                <TouchableOpacity
                  style={[styles.createButton, (!isStep2Valid || submitting) && styles.createButtonDisabled]}
                  onPress={handleCreateAccount}
                  disabled={!isStep2Valid || submitting}
                  activeOpacity={0.8}
                >
                  <Text style={styles.createButtonText}>
                    {submitting ? 'Creating Account...' : 'Sign Up'}
                  </Text>
                  {!submitting && <Text style={styles.createButtonArrow}>{Icons.arrowRight}</Text>}
                </TouchableOpacity>
              </Animated.View>
            </View>
          )}

          <TouchableOpacity style={styles.loginLink} onPress={() => navigation.navigate('Login')} activeOpacity={0.7}>
            <Text style={styles.loginLinkText}>
              Already have an account? <Text style={styles.loginLinkBold}>Login</Text>
            </Text>
          </TouchableOpacity>

          <Text style={styles.terms}>
            By creating an account, you agree to our{' '}
            <Text style={styles.termsLink}>Terms of Service</Text> and{' '}
            <Text style={styles.termsLink}>Privacy Policy</Text>.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: SCREEN_BG },
  keyboardView: { flex: 1 },
  header: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 12, zIndex: 10 },
  backButton: {
    width: 44, height: 44, borderRadius: 22, backgroundColor: BACK_BTN_BG,
    justifyContent: 'center', alignItems: 'center', marginBottom: 16,
  },
  backArrow: { fontSize: 22, color: DARK_TEXT, fontWeight: '600' },
  title: { fontFamily: 'Helvetica-Bold', fontSize: 26, color: DARK_TEXT, marginBottom: 4 },
  subtitle: { fontSize: 14, color: GRAY_TEXT, marginBottom: 16 },
  progressContainer: { marginTop: 4 },
  progressLabelRow: { marginBottom: 8 },
  progressLabel: { fontSize: 11, color: '#9CA3AF' },
  progressBar: { height: 4, backgroundColor: '#E5E7EB', borderRadius: 2, overflow: 'hidden' },
  progressFill: { height: '100%', backgroundColor: BRAND_GREEN, borderRadius: 2 },
  scrollView: { flex: 1 },
  scrollContent: { paddingHorizontal: 16, paddingBottom: 40 },
  formCard: {
    backgroundColor: WHITE, borderRadius: 16, padding: 20,
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 8, elevation: 2,
  },
  fieldContainer: { marginBottom: 20 },
  label: { fontSize: 13, color: LABEL_COLOR, fontWeight: '500', marginBottom: 6 },
  required: { color: ERROR_RED },
  inputWrapper: {
    flexDirection: 'row', alignItems: 'center', height: 56, borderWidth: 1.5,
    borderColor: BORDER_COLOR, borderRadius: 12, paddingHorizontal: 16, backgroundColor: INPUT_BG,
  },
  inputFocused: { borderColor: BRAND_GREEN, backgroundColor: FOCUS_BG, borderWidth: 2 },
  inputError: { borderColor: ERROR_RED },
  inputValid: { borderColor: BRAND_GREEN },
  fieldIcon: { fontSize: 18, marginRight: 10, opacity: 0.5 },
  input: { flex: 1, fontSize: 15, color: DARK_TEXT, padding: 0 },
  validIcon: { fontSize: 18, color: BRAND_GREEN, fontWeight: '700', marginLeft: 8 },
  errorIcon: { fontSize: 18, color: ERROR_RED, fontWeight: '700', marginLeft: 8 },
  errorText: { fontSize: 11, color: ERROR_RED, marginTop: 6, marginLeft: 4 },
  hintText: { fontSize: 11, color: '#9CA3AF', marginTop: 6, marginLeft: 4 },
  strengthRow: { flexDirection: 'row', alignItems: 'center', marginTop: 8, marginLeft: 4 },
  strengthTrack: { flex: 1, height: 5, borderRadius: 3, backgroundColor: '#E5E7EB', overflow: 'hidden', marginRight: 10 },
  strengthFill: { height: '100%', borderRadius: 3 },
  strengthLabel: { fontSize: 11, fontWeight: '700', width: 54, textAlign: 'right' },
  networkBadge: {
    flexDirection: 'row', alignItems: 'center', marginTop: 8, marginLeft: 4,
    paddingHorizontal: 10, paddingVertical: 5, borderRadius: 20, alignSelf: 'flex-start',
  },
  networkDot: { width: 6, height: 6, borderRadius: 3, marginRight: 6 },
  networkText: { fontSize: 12, fontWeight: '600' },
  pinContainer: { flexDirection: 'row', justifyContent: 'space-between' },
  pinBox: {
    width: 60, height: 64, borderWidth: 1.5, borderColor: BORDER_COLOR, borderRadius: 12,
    textAlign: 'center', fontSize: 22, fontFamily: 'Helvetica-Bold', backgroundColor: INPUT_BG, color: DARK_TEXT,
  },
  pinBoxFilled: { borderColor: BRAND_GREEN, backgroundColor: FOCUS_BG },
  createButton: {
    height: 56, backgroundColor: BRAND_GREEN, borderRadius: 14, flexDirection: 'row',
    justifyContent: 'center', alignItems: 'center', marginTop: 8, marginBottom: 4,
  },
  createButtonDisabled: { opacity: 0.6 },
  createButtonText: { fontFamily: 'Helvetica-Bold', fontSize: 16, color: WHITE },
  createButtonArrow: { fontSize: 18, color: WHITE, marginLeft: 8 },
  loginLink: { alignItems: 'center', marginTop: 20, marginBottom: 20 },
  loginLinkText: { fontSize: 14, color: GRAY_TEXT },
  loginLinkBold: { color: BRAND_GREEN, fontWeight: '700', textDecorationLine: 'underline' },
  terms: { fontSize: 11, color: '#9CA3AF', textAlign: 'center', lineHeight: 16, marginTop: 4 },
  termsLink: { color: BRAND_GREEN, fontWeight: '600' },
});
