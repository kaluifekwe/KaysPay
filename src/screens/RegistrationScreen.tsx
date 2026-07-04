import React, { useState, useRef, useEffect } from 'react';
import {
  View,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  SafeAreaView,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Modal,
  FlatList,
  Animated,
  Alert,
} from 'react-native';
import { authService } from '../services/auth.service';

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

const NIGERIAN_STATES = [
  'Abia', 'Adamawa', 'Akwa Ibom', 'Anambra', 'Bauchi', 'Bayelsa', 'Benue', 'Borno',
  'Cross River', 'Delta', 'Ebonyi', 'Edo', 'Ekiti', 'Enugu', 'FCT Abuja', 'Gombe',
  'Imo', 'Jigawa', 'Kaduna', 'Kano', 'Katsina', 'Kebbi', 'Kogi', 'Kwara', 'Lagos',
  'Nasarawa', 'Niger', 'Ogun', 'Ondo', 'Osun', 'Oyo', 'Plateau', 'Rivers', 'Sokoto',
  'Taraba', 'Yobe', 'Zamfara',
];

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

// Simple SVG-like icons using Unicode/text
const Icons = {
  user: '👤',
  mail: '✉',
  mapPin: '📍',
  home: '🏠',
  phone: '📱',
  search: '🔍',
  chevronDown: '▾',
  arrowRight: '→',
  check: '✓',
  close: '✕',
  back: '‹',
};

interface RegistrationScreenProps {
  navigation: any;
}

export default function RegistrationScreen({ navigation }: RegistrationScreenProps) {
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [state, setState] = useState('');
  const [address, setAddress] = useState('');
  const [phone, setPhone] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const [fullNameError, setFullNameError] = useState('');
  const [emailError, setEmailError] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [stateError, setStateError] = useState('');
  const [addressError, setAddressError] = useState('');
  const [phoneError, setPhoneError] = useState('');

  const [fullNameValid, setFullNameValid] = useState(false);
  const [emailValid, setEmailValid] = useState(false);
  const [passwordValid, setPasswordValid] = useState(false);
  const [stateValid, setStateValid] = useState(false);
  const [addressValid, setAddressValid] = useState(false);
  const [phoneValid, setPhoneValid] = useState(true); // phone is optional now

  const [showPassword, setShowPassword] = useState(false);
  const [showStatePicker, setShowStatePicker] = useState(false);
  const [stateSearch, setStateSearch] = useState('');
  const [detectedNetwork, setDetectedNetwork] = useState<string | null>(null);

  const [focusedField, setFocusedField] = useState<string | null>(null);

  const buttonScale = useRef(new Animated.Value(1)).current;
  const networkAnim = useRef(new Animated.Value(0)).current;

  const emailRef = useRef<TextInput>(null);
  const passwordRef = useRef<TextInput>(null);
  const addressRef = useRef<TextInput>(null);
  const phoneRef = useRef<TextInput>(null);
  const scrollRef = useRef<ScrollView>(null);

  useEffect(() => {
    validateFullName(fullName);
    validateEmail(email);
    validatePassword(password);
    validateAddress(address);
    validatePhone(phone);
  }, [fullName, email, password, address, phone, state]);

  useEffect(() => {
    if (detectedNetwork) {
      Animated.spring(networkAnim, {
        toValue: 1,
        useNativeDriver: true,
        tension: 50,
        friction: 7,
      }).start();
    } else {
      networkAnim.setValue(0);
    }
  }, [detectedNetwork]);

  const validateFullName = (value: string) => {
    if (!value.trim()) {
      setFullNameError('');
      setFullNameValid(false);
      return false;
    }
    const words = value.trim().split(/\s+/);
    const hasNumbers = /\d/.test(value);
    if (words.length < 2 || hasNumbers) {
      setFullNameError('Please enter your full name (first and last)');
      setFullNameValid(false);
      return false;
    }
    setFullNameError('');
    setFullNameValid(true);
    return true;
  };

  const validateEmail = (value: string) => {
    if (!value.trim()) {
      setEmailError('');
      setEmailValid(false);
      return false;
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(value)) {
      setEmailError('Please enter a valid email address');
      setEmailValid(false);
      return false;
    }
    setEmailError('');
    setEmailValid(true);
    return true;
  };

  const validatePassword = (value: string) => {
    if (!value) {
      setPasswordError('');
      setPasswordValid(false);
      return false;
    }
    if (value.length < 6) {
      setPasswordError('Password must be at least 6 characters');
      setPasswordValid(false);
      return false;
    }
    setPasswordError('');
    setPasswordValid(true);
    return true;
  };

  const validateState = (value: string) => {
    if (!value) {
      setStateError('');
      setStateValid(false);
      return false;
    }
    setStateError('');
    setStateValid(true);
    return true;
  };

  const validateAddress = (value: string) => {
    if (!value.trim()) {
      setAddressError('');
      setAddressValid(false);
      return false;
    }
    if (value.trim().length < 10) {
      setAddressError('Please enter a valid address');
      setAddressValid(false);
      return false;
    }
    setAddressError('');
    setAddressValid(true);
    return true;
  };

  // Phone is optional now (the app serves users outside Nigeria too) — only
  // validate format when something is entered, and only show the network
  // badge when it happens to match a Nigerian prefix. A blank field, or a
  // non-Nigerian number, is fine either way.
  const validatePhone = (value: string) => {
    if (!value.trim()) {
      setPhoneError('');
      setPhoneValid(true);
      setDetectedNetwork(null);
      return true;
    }
    const cleanPhone = value.replace(/\s/g, '');
    if (cleanPhone.length < 7 || cleanPhone.length > 15) {
      setPhoneError('Please enter a valid phone number');
      setPhoneValid(false);
      setDetectedNetwork(null);
      return false;
    }
    let isNigerianPrefix = false;
    if (cleanPhone.startsWith('0') && cleanPhone.length === 11) {
      isNigerianPrefix = NIGERIAN_PREFIXES.includes(cleanPhone.substring(0, 4));
    } else if (!cleanPhone.startsWith('0') && cleanPhone.length === 10) {
      isNigerianPrefix = NIGERIAN_PREFIXES.includes('0' + cleanPhone.substring(0, 3));
    }
    setPhoneError('');
    setPhoneValid(true);
    if (!isNigerianPrefix) {
      setDetectedNetwork(null);
      return true;
    }
    const network = detectNetwork(cleanPhone);
    setDetectedNetwork(network);
    return true;
  };

  const isFormValid =
    fullNameValid && emailValid && passwordValid && stateValid && addressValid && phoneValid;

  const handlePhoneChange = (text: string) => {
    const cleaned = text.replace(/[^0-9]/g, '');
    if (cleaned.length <= 15) {
      setPhone(cleaned);
    }
  };

  const handleCreateAccount = async () => {
    if (!isFormValid || submitting) return;

    Animated.sequence([
      Animated.timing(buttonScale, { toValue: 0.97, duration: 100, useNativeDriver: true }),
      Animated.timing(buttonScale, { toValue: 1, duration: 100, useNativeDriver: true }),
    ]).start();

    let formattedPhone = phone.trim();
    if (formattedPhone) {
      // Only Nigerian-formatted local numbers (leading 0, 11 digits) get the
      // +234 prefix assumed — anything else is left as-is since we no
      // longer require a Nigerian number.
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
        state,
        address: address.trim(),
        phone: formattedPhone || null,
      });

      if (!result.success) {
        Alert.alert('Sign Up Failed', result.error || 'Something went wrong. Please try again.');
        return;
      }

      if (result.needsEmailConfirmation) {
        Alert.alert(
          'Check Your Email',
          'Please confirm your email address before continuing, then log in.',
          [{ text: 'OK', onPress: () => navigation.replace('Login') }],
        );
        return;
      }

      // No manual navigation here — AppNavigator's root-level auth listener
      // detects the new session and swaps straight to the mandatory PIN
      // setup gate on its own (see RequirePinNavigator).
    } catch (error: any) {
      Alert.alert('Sign Up Failed', error.message || 'Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const filteredStates = NIGERIAN_STATES.filter((s) =>
    s.toLowerCase().includes(stateSearch.toLowerCase())
  );

  const getFieldStyle = (hasError: boolean, isValid: boolean, isFocused: boolean) => {
    if (hasError) return styles.inputError;
    if (isFocused) return styles.inputFocused;
    if (isValid) return styles.inputValid;
    return null;
  };

  const renderFieldIcon = (icon: string) => (
    <Text style={styles.fieldIcon}>{icon}</Text>
  );

  const renderStatusIcon = (hasError: boolean, isValid: boolean) => {
    if (hasError) return <Text style={styles.errorIcon}>×</Text>;
    if (isValid) return <Text style={styles.validIcon}>✓</Text>;
    return null;
  };

  const renderError = (error: string) => {
    if (!error) return null;
    return <Text style={styles.errorText}>{error}</Text>;
  };

  const renderLabel = (label: string, required: boolean = true) => (
    <Text style={styles.label}>
      {label}
      {required && <Text style={styles.required}> *</Text>}
    </Text>
  );

  return (
    <SafeAreaView style={styles.container}>
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
            <Text style={styles.backArrow}>{Icons.back}</Text>
          </TouchableOpacity>
          <Text style={styles.title}>Create Account</Text>
          <Text style={styles.subtitle}>Fill in your details to get started</Text>

          <View style={styles.progressContainer}>
            <View style={styles.progressLabelRow}>
              <Text style={styles.progressLabel}>Step 1 of 2 — Personal Details</Text>
            </View>
            <View style={styles.progressBar}>
              <View style={[styles.progressFill, { width: '50%' }]} />
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
          <View style={styles.formCard}>
            {/* Full Name */}
            <View style={styles.fieldContainer}>
              {renderLabel('Full Name')}
              <View style={[
                styles.inputWrapper,
                getFieldStyle(!!fullNameError, fullNameValid, focusedField === 'fullName'),
              ]}>
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

            {/* Email */}
            <View style={styles.fieldContainer}>
              {renderLabel('Email Address')}
              <View style={[
                styles.inputWrapper,
                getFieldStyle(!!emailError, emailValid, focusedField === 'email'),
              ]}>
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
            </View>

            {/* Password */}
            <View style={styles.fieldContainer}>
              {renderLabel('Password')}
              <View style={[
                styles.inputWrapper,
                getFieldStyle(!!passwordError, passwordValid, focusedField === 'password'),
              ]}>
                <Text style={styles.fieldIcon}>🔒</Text>
                <TextInput
                  ref={passwordRef}
                  style={styles.input}
                  placeholder="At least 6 characters"
                  placeholderTextColor="#9CA3AF"
                  value={password}
                  onChangeText={setPassword}
                  onFocus={() => setFocusedField('password')}
                  onBlur={() => setFocusedField(null)}
                  secureTextEntry={!showPassword}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                <TouchableOpacity onPress={() => setShowPassword((v) => !v)} activeOpacity={0.7}>
                  <Text style={styles.fieldIcon}>{showPassword ? '🙈' : '👁'}</Text>
                </TouchableOpacity>
                {renderStatusIcon(!!passwordError, passwordValid)}
              </View>
              {renderError(passwordError)}
            </View>

            {/* State */}
            <View style={styles.fieldContainer}>
              {renderLabel('State')}
              <TouchableOpacity
                style={[
                  styles.inputWrapper,
                  getFieldStyle(!!stateError, stateValid, false),
                ]}
                onPress={() => setShowStatePicker(true)}
                activeOpacity={0.7}
              >
                {renderFieldIcon(Icons.mapPin)}
                <Text style={[styles.input, !state && styles.placeholderText]}>
                  {state || 'Select your state'}
                </Text>
                <Text style={styles.chevronIcon}>{Icons.chevronDown}</Text>
              </TouchableOpacity>
              {renderError(stateError)}
            </View>

            {/* Address */}
            <View style={styles.fieldContainer}>
              {renderLabel('Home Address')}
              <View style={[
                styles.inputWrapper,
                styles.textAreaWrapper,
                getFieldStyle(!!addressError, addressValid, focusedField === 'address'),
              ]}>
                {renderFieldIcon(Icons.home)}
                <TextInput
                  ref={addressRef}
                  style={[styles.input, styles.textArea]}
                  placeholder="e.g. 12 Awolowo Road, Ikeja"
                  placeholderTextColor="#9CA3AF"
                  value={address}
                  onChangeText={setAddress}
                  onFocus={() => setFocusedField('address')}
                  onBlur={() => setFocusedField(null)}
                  multiline
                  numberOfLines={2}
                  textAlignVertical="top"
                />
                {addressValid && (
                  <View style={styles.checkmarkTextArea}>
                    {renderStatusIcon(false, true)}
                  </View>
                )}
              </View>
              {renderError(addressError)}
            </View>

            {/* Phone */}
            <View style={styles.fieldContainer}>
              {renderLabel('Phone Number', false)}
              <View style={[
                styles.inputWrapper,
                getFieldStyle(!!phoneError, phoneValid, focusedField === 'phone'),
              ]}>
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
              {renderError(phoneError)}
            </View>
          </View>

          {/* Create Account Button */}
          <Animated.View style={{ transform: [{ scale: buttonScale }] }}>
            <TouchableOpacity
              style={[styles.createButton, (!isFormValid || submitting) && styles.createButtonDisabled]}
              onPress={handleCreateAccount}
              disabled={!isFormValid || submitting}
              activeOpacity={0.8}
            >
              <Text style={styles.createButtonText}>
                {submitting ? 'Creating Account...' : 'Create Account'}
              </Text>
              {!submitting && <Text style={styles.createButtonArrow}>{Icons.arrowRight}</Text>}
            </TouchableOpacity>
          </Animated.View>

          {/* Login Link */}
          <TouchableOpacity
            style={styles.loginLink}
            onPress={() => navigation.navigate('Login')}
            activeOpacity={0.7}
          >
            <Text style={styles.loginLinkText}>
              Already have an account? <Text style={styles.loginLinkBold}>Login</Text>
            </Text>
          </TouchableOpacity>

          {/* Terms */}
          <Text style={styles.terms}>
            By creating an account, you agree to our{' '}
            <Text style={styles.termsLink}>Terms of Service</Text> and{' '}
            <Text style={styles.termsLink}>Privacy Policy</Text>.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>

      {/* State Picker Modal */}
      <Modal
        visible={showStatePicker}
        animationType="slide"
        transparent
        onRequestClose={() => setShowStatePicker(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.dragHandle} />
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Select State</Text>
              <TouchableOpacity
                style={styles.modalCloseBtn}
                onPress={() => {
                  setShowStatePicker(false);
                  setStateSearch('');
                }}
              >
                <Text style={styles.modalClose}>{Icons.close}</Text>
              </TouchableOpacity>
            </View>
            <View style={styles.searchContainer}>
              <Text style={styles.searchIcon}>{Icons.search}</Text>
              <TextInput
                style={styles.searchInput}
                placeholder="Search state..."
                placeholderTextColor="#9CA3AF"
                value={stateSearch}
                onChangeText={setStateSearch}
                autoFocus
              />
            </View>
            <FlatList
              data={filteredStates}
              keyExtractor={(item) => item}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={[styles.stateItem, state === item && styles.stateItemSelected]}
                  onPress={() => {
                    setState(item);
                    setShowStatePicker(false);
                    setStateSearch('');
                    validateState(item);
                  }}
                >
                  <Text style={[styles.stateItemText, state === item && styles.stateItemSelectedText]}>
                    {item}
                  </Text>
                  {state === item && <Text style={styles.stateItemCheck}>✓</Text>}
                </TouchableOpacity>
              )}
              showsVerticalScrollIndicator={false}
            />
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: SCREEN_BG,
  },
  keyboardView: {
    flex: 1,
  },
  header: {
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 12,
    zIndex: 10,
  },
  backButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: BACK_BTN_BG,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 16,
  },
  backArrow: {
    fontSize: 22,
    color: DARK_TEXT,
    fontWeight: '600',
  },
  title: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 26,
    color: DARK_TEXT,
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 14,
    color: GRAY_TEXT,
    marginBottom: 16,
  },
  progressContainer: {
    marginTop: 4,
  },
  progressLabelRow: {
    marginBottom: 8,
  },
  progressLabel: {
    fontSize: 11,
    color: '#9CA3AF',
  },
  progressBar: {
    height: 4,
    backgroundColor: '#E5E7EB',
    borderRadius: 2,
    overflow: 'hidden',
  },
  progressFill: {
    width: '33%',
    height: '100%',
    backgroundColor: BRAND_GREEN,
    borderRadius: 2,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 16,
    paddingBottom: 40,
  },
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
  fieldContainer: {
    marginBottom: 20,
  },
  label: {
    fontSize: 13,
    color: LABEL_COLOR,
    fontWeight: '500',
    marginBottom: 6,
  },
  required: {
    color: ERROR_RED,
  },
  inputWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 56,
    borderWidth: 1.5,
    borderColor: BORDER_COLOR,
    borderRadius: 12,
    paddingHorizontal: 16,
    backgroundColor: INPUT_BG,
  },
  inputFocused: {
    borderColor: BRAND_GREEN,
    backgroundColor: FOCUS_BG,
    borderWidth: 2,
  },
  inputError: {
    borderColor: ERROR_RED,
  },
  inputValid: {
    borderColor: BRAND_GREEN,
  },
  fieldIcon: {
    fontSize: 18,
    marginRight: 10,
    opacity: 0.5,
  },
  input: {
    flex: 1,
    fontSize: 15,
    color: DARK_TEXT,
    padding: 0,
  },
  placeholderText: {
    color: '#9CA3AF',
  },
  validIcon: {
    fontSize: 18,
    color: BRAND_GREEN,
    fontWeight: '700',
    marginLeft: 8,
  },
  errorIcon: {
    fontSize: 18,
    color: ERROR_RED,
    fontWeight: '700',
    marginLeft: 8,
  },
  errorText: {
    fontSize: 11,
    color: ERROR_RED,
    marginTop: 6,
    marginLeft: 4,
  },
  chevronIcon: {
    fontSize: 16,
    color: '#9CA3AF',
    marginLeft: 8,
  },
  textAreaWrapper: {
    height: 80,
    alignItems: 'flex-start',
    paddingTop: 16,
  },
  textArea: {
    height: '100%',
    paddingTop: 0,
  },
  checkmarkTextArea: {
    position: 'absolute',
    right: 16,
    top: 16,
  },
  networkBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 8,
    marginLeft: 4,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 20,
    alignSelf: 'flex-start',
  },
  networkDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginRight: 6,
  },
  networkText: {
    fontSize: 12,
    fontWeight: '600',
  },
  createButton: {
    height: 56,
    backgroundColor: BRAND_GREEN,
    borderRadius: 14,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 8,
    marginBottom: 20,
    opacity: 1,
  },
  createButtonDisabled: {
    opacity: 0.6,
  },
  createButtonText: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 16,
    color: WHITE,
  },
  createButtonArrow: {
    fontSize: 18,
    color: WHITE,
    marginLeft: 8,
  },
  loginLink: {
    alignItems: 'center',
    marginTop: 4,
    marginBottom: 20,
  },
  loginLinkText: {
    fontSize: 14,
    color: GRAY_TEXT,
  },
  loginLinkBold: {
    color: BRAND_GREEN,
    fontWeight: '700',
    textDecorationLine: 'underline',
  },
  terms: {
    fontSize: 11,
    color: '#9CA3AF',
    textAlign: 'center',
    lineHeight: 16,
    marginTop: 4,
  },
  termsLink: {
    color: BRAND_GREEN,
    fontWeight: '600',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    backgroundColor: WHITE,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: '60%',
    paddingBottom: 34,
  },
  dragHandle: {
    width: 32,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#D1D5DB',
    alignSelf: 'center',
    marginTop: 12,
    marginBottom: 8,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  modalTitle: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 18,
    color: DARK_TEXT,
  },
  modalCloseBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: BACK_BTN_BG,
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalClose: {
    fontSize: 14,
    color: GRAY_TEXT,
  },
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 20,
    marginBottom: 8,
    height: 48,
    borderWidth: 1,
    borderColor: BORDER_COLOR,
    borderRadius: 10,
    paddingHorizontal: 12,
    backgroundColor: '#F9FAFB',
  },
  searchIcon: {
    fontSize: 14,
    marginRight: 8,
    opacity: 0.5,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    color: DARK_TEXT,
    padding: 0,
  },
  stateItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    height: 48,
    borderBottomWidth: 0.5,
    borderBottomColor: BORDER_COLOR,
  },
  stateItemSelected: {
    backgroundColor: '#E8F5E9',
  },
  stateItemText: {
    fontSize: 14,
    color: DARK_TEXT,
  },
  stateItemSelectedText: {
    color: BRAND_GREEN,
    fontWeight: '600',
  },
  stateItemCheck: {
    fontSize: 16,
    color: BRAND_GREEN,
    fontWeight: '700',
  },
});
