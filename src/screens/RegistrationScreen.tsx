import React, { useState, useRef, useEffect } from 'react';
import {
  View,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  Animated,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { authService } from '../services/auth.service';
import { supabase } from '../lib/supabase';
import { MIN_PASSWORD_LENGTH, passwordValidationError } from '../utils/password';
import { validateNigerianPhone } from '../utils/detectNetwork';
import { safeErrorMessage } from '../utils/errorMessages';
import { AppTheme } from '../constants/theme';
import { useTheme } from '../components/ThemeProvider';
import { analytics } from '../services/analytics.service';
import { useSensitiveScreenProtection } from '../hooks/useSensitiveScreenProtection';

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

const Icons = {
  back: '‹',
};

interface RegistrationScreenProps {
  navigation: any;
}

export default function RegistrationScreen({ navigation }: RegistrationScreenProps) {
  const { theme } = useTheme();
  const styles = createStyles(theme);
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
  const [phoneValid, setPhoneValid] = useState(false);
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
  // PIN digits are always secureTextEntry-masked here — only the password
  // reveal toggle ever renders a real plaintext secret, so that's the only
  // moment worth blocking. Keeps every error state on Step 2 screenshottable.
  useSensitiveScreenProtection(showPassword || showConfirmPassword);

  const [submitting, setSubmitting] = useState(false);
  const [marketingEmailOptIn, setMarketingEmailOptIn] = useState(false);
  const [focusedField, setFocusedField] = useState<string | null>(null);
  // Optional creator/promo code, attributed permanently at signup (see
  // redeem_promo_code, migration 219). Never blocks account creation --
  // a wrong or empty code is simply not recorded, not an error the user
  // needs to fix before continuing.
  const [promoCode, setPromoCode] = useState('');

  const buttonScale = useRef(new Animated.Value(1)).current;
  const networkAnim = useRef(new Animated.Value(0)).current;

  const emailRef = useRef<TextInput>(null);
  const scrollRef = useRef<ScrollView>(null);
  const phoneRef = useRef<TextInput>(null);
  const confirmPasswordRef = useRef<TextInput>(null);
  const pinRefs = useRef<(TextInput | null)[]>([]);
  const confirmPinRefs = useRef<(TextInput | null)[]>([]);

  useEffect(() => {
    void analytics.track('registration_started', { outcome: 'started' });
  }, []);

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

  const validatePhone = (value: string) => {
    if (!value.trim()) {
      setPhoneError('');
      setPhoneValid(false);
      setDetectedNetwork(null);
      return;
    }
    const cleanPhone = value.replace(/\s/g, '');
    // Reject anything that isn't a real 11-digit, 0-prefixed Nigerian number
    // with a recognized carrier prefix -- this used to only gate the network
    // badge, not validity, so e.g. a 10-digit number typed without the
    // leading 0 sailed through as "valid" and later got a bare "+" slapped
    // on it at submission, saving something like "+9044931977" -- not a
    // real, dialable number. Matches PhoneInputScreen's validateNigerianPhone.
    if (!validateNigerianPhone(cleanPhone)) {
      setPhoneError('Please enter a valid 11-digit Nigerian number (e.g., 08031234567)');
      setPhoneValid(false);
      setDetectedNetwork(null);
      return;
    }
    setPhoneError('');
    setPhoneValid(true);
    setDetectedNetwork(detectNetwork(cleanPhone));
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
    if (!isStep1Valid) {
      void analytics.track('registration_validation_failed', { outcome: 'failed', failureCode: 'personal_details_invalid' });
      return;
    }
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
      void analytics.track('pin_setup_failed', { outcome: 'failed', failureCode: 'pin_mismatch' });
      return;
    }

    Animated.sequence([
      Animated.timing(buttonScale, { toValue: 0.97, duration: 100, useNativeDriver: true }),
      Animated.timing(buttonScale, { toValue: 1, duration: 100, useNativeDriver: true }),
    ]).start();

    // isStep1Valid already required validateNigerianPhone to pass before this
    // screen could be reached, so phone is always exactly 11 digits starting
    // with 0 here -- no fallback branch, which used to blindly prepend "+"
    // to whatever didn't match and could save a non-dialable number.
    let formattedPhone = phone.trim();
    if (formattedPhone.startsWith('0') && formattedPhone.length === 11) {
      formattedPhone = '+234' + formattedPhone.substring(1);
    }

    setSubmitting(true);
    void analytics.track('registration_submitted', { outcome: 'started' });
    try {
      const result = await authService.signUpWithEmail(email.trim().toLowerCase(), password, {
        full_name: fullName.trim(),
        phone: formattedPhone || null,
        marketing_email_opt_in: marketingEmailOptIn,
      });

      if (!result.success) {
        void analytics.track('registration_validation_failed', { outcome: 'failed', failureCode: 'signup_rejected' });
        Alert.alert('Sign Up Failed', result.error || 'Something went wrong. Please try again.');
        return;
      }

      void analytics.track('account_created', { outcome: 'completed' });

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
      // is fully established). Keyed to this account's own user id so it can
      // never be picked up by a different account signed in later on this
      // device.
      const newUserId = result.userId;
      if (newUserId) {
        await authService.stashSignupPin(newUserId, pinString);
        // Separate stash so AppNavigator can offer biometric enrollment once,
        // right after email verification — RequirePinNavigator's own
        // BiometricSetup step never runs for these users since a PIN already
        // exists by then.
        await authService.stashPinForBiometricPrompt(newUserId, pinString);
      }

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

      // Best-effort, same reasoning as the PIN save below: needs the
      // refreshed session above for auth.uid() to resolve inside the RPC. A
      // wrong or empty code is not an error state -- redeem_promo_code
      // itself never throws for that, and this must never block or delay
      // account creation, which has already succeeded by this point.
      if (promoCode.trim()) {
        try {
          await supabase.rpc('redeem_promo_code', { p_code: promoCode.trim() });
        } catch {
          // ignore — not worth retrying or surfacing; the code just won't be attributed
        }
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
        // silently dropping the user onto the PIN gate. Not a dead end for
        // the customer -- the stash above means ensurePinSaved retries this
        // after email verification -- but it's a real failed attempt worth
        // recording; this step previously had zero failure signal at all.
        console.warn('Signup: PIN save failed after retries:', lastPinError);
        void analytics.track('pin_setup_failed', { outcome: 'failed', failureCode: 'pin_save_failed' });
      } else if (newUserId) {
        void analytics.track('pin_setup_completed', { outcome: 'completed' });
        // Saved immediately — clear the stash now rather than leaving it on
        // the device for ensurePinSaved to find later (it won't run again
        // once hasPin is true, so this is the only cleanup this account gets).
        await authService.clearStashedPin(newUserId);
      }

      // No manual navigation — AppNavigator's root-level auth listener
      // detects the new session and swaps to the email-verify gate on its
      // own (see RequireEmailVerifyNavigator).
    } catch (error: any) {
      void analytics.track('registration_validation_failed', { outcome: 'failed', failureCode: 'signup_unavailable' });
      Alert.alert('Sign Up Failed', safeErrorMessage(error, 'Something went wrong. Please try again.'));
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

  const renderFieldIcon = (name: keyof typeof Ionicons.glyphMap) => (
    <Ionicons name={name} size={18} color={theme.inkMuted} style={styles.fieldIconIonicon} />
  );

  const renderStatusIcon = (hasError: boolean, isValid: boolean) => {
    if (hasError) return <Ionicons name="close-circle" size={18} color={theme.down} style={styles.statusIcon} />;
    if (isValid) return <Ionicons name="checkmark-circle" size={18} color={theme.brand} style={styles.statusIcon} />;
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
      <KeyboardAvoidingView style={styles.keyboardView} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.header}>
          <TouchableOpacity
            style={styles.backButton}
            activeOpacity={0.7}
            onPress={() => (step === 2 ? setStep(1) : navigation.goBack())}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Text style={styles.backArrow}>{Icons.back}</Text>
          </TouchableOpacity>
          <View style={styles.brandRow}>
            <View style={styles.brandTile}>
              <Image source={require('../../assets/icon-green.png')} style={styles.brandTileImg} resizeMode="contain" />
            </View>
            <Text style={styles.brandName}>KaysPay</Text>
          </View>
          <Text style={styles.title}>Join KaysPay</Text>
          <Text style={styles.subtitle}>
            {step === 1 ? 'Send money, pay bills, and buy airtime in minutes' : 'Secure your account'}
          </Text>

          <View style={styles.progressContainer}>
            <View style={styles.progressSegments}>
              <View style={[styles.progressSegment, styles.progressSegmentFilled]} />
              <View style={[styles.progressSegment, step === 2 && styles.progressSegmentFilled]} />
              <Text style={styles.progressLabel}>{step} of 2</Text>
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
                {renderLabel('Full name')}
                <View style={[styles.inputWrapper, getFieldStyle(!!fullNameError, fullNameValid, focusedField === 'fullName')]}>
                  {renderFieldIcon('person-outline')}
                  <TextInput
                    style={styles.input}
                    placeholder="Enter your full name"
                    placeholderTextColor={theme.inkMuted}
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
                {renderLabel('Email address')}
                <View style={[styles.inputWrapper, getFieldStyle(!!emailError, emailValid, focusedField === 'email')]}>
                  {renderFieldIcon('mail-outline')}
                  <TextInput
                    ref={emailRef}
                    style={styles.input}
                    placeholder="Enter your email address"
                    placeholderTextColor={theme.inkMuted}
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
                {renderLabel('Phone number')}
                <View style={[styles.inputWrapper, getFieldStyle(!!phoneError, phoneValid, focusedField === 'phone')]}>
                  {renderFieldIcon('call-outline')}
                  <TextInput
                    ref={phoneRef}
                    style={styles.input}
                    placeholder="Enter your phone number"
                    placeholderTextColor={theme.inkMuted}
                    value={phone}
                    onChangeText={handlePhoneChange}
                    onFocus={() => {
                      setFocusedField('phone');
                      scrollRef.current?.scrollToEnd({ animated: true });
                    }}
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
                <Text style={styles.createButtonText}>Continue</Text>
                <Ionicons name="arrow-forward" size={18} color="#FFFFFF" style={styles.createButtonArrowIcon} />
              </TouchableOpacity>
            </View>
          ) : (
            <View style={styles.formCard}>
              <View style={styles.fieldContainer}>
                {renderLabel('Password')}
                <View style={[styles.inputWrapper, getFieldStyle(!!passwordError, password.length >= MIN_PASSWORD_LENGTH, focusedField === 'password')]}>
                  {renderFieldIcon('lock-closed-outline')}
                  <TextInput
                    style={styles.input}
                    placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
                    placeholderTextColor={theme.inkMuted}
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
                    <Ionicons
                      name={showPassword ? 'eye-off-outline' : 'eye-outline'}
                      size={18}
                      color={theme.inkMuted}
                      style={styles.fieldIconIonicon}
                    />
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
                          { width: `${passwordStrength(password, theme).pct}%`, backgroundColor: passwordStrength(password, theme).color },
                        ]}
                      />
                    </View>
                    <Text style={[styles.strengthLabel, { color: passwordStrength(password, theme).color }]}>
                      {passwordStrength(password, theme).label}
                    </Text>
                  </View>
                )}
              </View>

              <View style={styles.fieldContainer}>
                {renderLabel('Confirm password')}
                <View style={[styles.inputWrapper, getFieldStyle(!!confirmPasswordError, confirmPassword.length > 0 && !confirmPasswordError, focusedField === 'confirmPassword')]}>
                  {renderFieldIcon('lock-closed-outline')}
                  <TextInput
                    ref={confirmPasswordRef}
                    style={styles.input}
                    placeholder="Re-enter your password"
                    placeholderTextColor={theme.inkMuted}
                    value={confirmPassword}
                    onChangeText={setConfirmPassword}
                    onFocus={() => setFocusedField('confirmPassword')}
                    onBlur={() => setFocusedField(null)}
                    secureTextEntry={!showConfirmPassword}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                  <TouchableOpacity onPress={() => setShowConfirmPassword((v) => !v)} activeOpacity={0.7}>
                    <Ionicons
                      name={showConfirmPassword ? 'eye-off-outline' : 'eye-outline'}
                      size={18}
                      color={theme.inkMuted}
                      style={styles.fieldIconIonicon}
                    />
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
                {renderLabel('Confirm transaction PIN')}
                {renderPinRow(confirmPin, setConfirmPin, confirmPinRefs)}
                {renderError(pinError)}
              </View>

              <View style={styles.fieldContainer}>
                {renderLabel('Promo code (optional)')}
                <View style={[styles.inputWrapper, getFieldStyle(false, false, focusedField === 'promoCode')]}>
                  {renderFieldIcon('pricetag-outline')}
                  <TextInput
                    style={styles.input}
                    placeholder="Have a promo code? Enter it here"
                    placeholderTextColor={theme.inkMuted}
                    value={promoCode}
                    onChangeText={setPromoCode}
                    onFocus={() => setFocusedField('promoCode')}
                    onBlur={() => setFocusedField(null)}
                    autoCapitalize="characters"
                    autoCorrect={false}
                    returnKeyType="done"
                  />
                </View>
              </View>

              <TouchableOpacity
                style={styles.marketingConsentRow}
                onPress={() => setMarketingEmailOptIn((value) => !value)}
                activeOpacity={0.75}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: marketingEmailOptIn }}
                accessibilityLabel="Receive occasional KaysPay product and onboarding emails"
              >
                <View style={[styles.marketingCheckbox, marketingEmailOptIn && styles.marketingCheckboxChecked]}>
                  {marketingEmailOptIn && <Ionicons name="checkmark" size={16} color="#FFFFFF" />}
                </View>
                <View style={styles.marketingConsentCopy}>
                  <Text style={styles.marketingConsentTitle}>Email me helpful KaysPay updates</Text>
                  <Text style={styles.marketingConsentDescription}>Optional. Receive occasional onboarding tips and product offers. You can unsubscribe at any time.</Text>
                </View>
              </TouchableOpacity>

              <Animated.View style={{ transform: [{ scale: buttonScale }] }}>
                <TouchableOpacity
                  style={[styles.createButton, (!isStep2Valid || submitting) && styles.createButtonDisabled]}
                  onPress={handleCreateAccount}
                  disabled={!isStep2Valid || submitting}
                  activeOpacity={0.8}
                >
                  <Text style={styles.createButtonText}>
                    {submitting ? 'Creating account...' : 'Create account'}
                  </Text>
                  {!submitting && (
                    <Ionicons name="arrow-forward" size={18} color="#FFFFFF" style={styles.createButtonArrowIcon} />
                  )}
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

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.background },
  keyboardView: { flex: 1 },
  header: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 12, zIndex: 10 },
  backButton: {
    width: 44, height: 44, borderRadius: 22, backgroundColor: theme.surfaceRaised,
    justifyContent: 'center', alignItems: 'center', marginBottom: 16,
  },
  backArrow: { fontSize: 22, color: theme.ink, fontWeight: '600' },
  brandRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 18 },
  brandTile: {
    width: 40, height: 40, borderRadius: 12, backgroundColor: theme.brand,
    justifyContent: 'center', alignItems: 'center', marginRight: 10, overflow: 'hidden',
  },
  brandTileImg: { width: 40, height: 40 },
  brandName: { fontFamily: 'Helvetica-Bold', fontSize: 15, color: theme.ink },
  title: { fontFamily: 'Helvetica-Bold', fontSize: 26, color: theme.ink, marginBottom: 4 },
  subtitle: { fontSize: 14, color: theme.inkMuted, marginBottom: 16 },
  progressContainer: { marginTop: 4 },
  progressSegments: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  progressSegment: { flex: 1, height: 3, borderRadius: 2, backgroundColor: theme.surfaceRaised },
  progressSegmentFilled: { backgroundColor: theme.brand },
  progressLabel: { fontSize: 11, color: theme.inkMuted, fontWeight: '500' },
  scrollView: { flex: 1 },
  scrollContent: { paddingHorizontal: 16, paddingBottom: 40 },
  formCard: {
    backgroundColor: theme.surface, borderRadius: 16, padding: 20,
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 8, elevation: 2,
  },
  fieldContainer: { marginBottom: 14 },
  label: { fontSize: 13, color: theme.ink, fontWeight: '500', marginBottom: 6 },
  required: { color: theme.down },
  inputWrapper: {
    flexDirection: 'row', alignItems: 'center', height: 56, borderWidth: 1.5,
    borderColor: theme.border, borderRadius: 12, paddingHorizontal: 16, backgroundColor: theme.surface,
  },
  inputFocused: { borderColor: theme.brand, backgroundColor: theme.surfaceRaised2, borderWidth: 2 },
  inputError: { borderColor: theme.down },
  inputValid: { borderColor: theme.brand },
  fieldIconIonicon: { marginRight: 10 },
  input: { flex: 1, fontSize: 15, color: theme.ink, padding: 0 },
  statusIcon: { marginLeft: 8 },
  errorText: { fontSize: 11, color: theme.down, marginTop: 6, marginLeft: 4 },
  hintText: { fontSize: 11, color: theme.inkMuted, marginTop: 6, marginLeft: 4 },
  strengthRow: { flexDirection: 'row', alignItems: 'center', marginTop: 8, marginLeft: 4 },
  strengthTrack: { flex: 1, height: 5, borderRadius: 3, backgroundColor: theme.surfaceRaised, overflow: 'hidden', marginRight: 10 },
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
    width: 60, height: 64, borderWidth: 1.5, borderColor: theme.border, borderRadius: 12,
    textAlign: 'center', fontSize: 22, fontFamily: 'Helvetica-Bold', backgroundColor: theme.surface, color: theme.ink,
  },
  pinBoxFilled: { borderColor: theme.brand, backgroundColor: theme.surfaceRaised2 },
  createButton: {
    height: 56, backgroundColor: theme.brand, borderRadius: 14, flexDirection: 'row',
    justifyContent: 'center', alignItems: 'center', marginTop: 8, marginBottom: 4,
  },
  createButtonDisabled: { opacity: 0.6 },
  createButtonText: { fontFamily: 'Helvetica-Bold', fontSize: 16, color: '#FFFFFF' },
  createButtonArrowIcon: { marginLeft: 8 },
  marketingConsentRow: { minHeight: 52, flexDirection: 'row', alignItems: 'flex-start', marginBottom: 16, paddingVertical: 4 },
  marketingCheckbox: { width: 24, height: 24, borderRadius: 6, borderWidth: 1.5, borderColor: theme.border, alignItems: 'center', justifyContent: 'center', marginRight: 12, marginTop: 1 },
  marketingCheckboxChecked: { backgroundColor: theme.brand, borderColor: theme.brand },
  marketingConsentCopy: { flex: 1 },
  marketingConsentTitle: { fontSize: 13, fontWeight: '600', color: theme.ink, marginBottom: 3 },
  marketingConsentDescription: { fontSize: 11, lineHeight: 16, color: theme.inkMuted },
  loginLink: { alignItems: 'center', marginTop: 20, marginBottom: 20 },
  loginLinkText: { fontSize: 14, color: theme.inkMuted },
  loginLinkBold: { color: theme.brand, fontWeight: '700', textDecorationLine: 'underline' },
  terms: { fontSize: 11, color: theme.inkMuted, textAlign: 'center', lineHeight: 16, marginTop: 4 },
  termsLink: { color: theme.brand, fontWeight: '600' },
  });
}
