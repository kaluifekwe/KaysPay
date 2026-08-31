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
  ScrollView,
  Keyboard,
  Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { authService } from '../services/auth.service';
import { AppTheme } from '../constants/theme';
import { useTheme } from '../components/ThemeProvider';
import { passwordValidationError } from '../utils/password';

interface LoginScreenProps {
  navigation: any;
}

export default function LoginScreen({ navigation }: LoginScreenProps) {
  const { theme } = useTheme();
  const styles = createStyles(theme);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [focusedField, setFocusedField] = useState<string | null>(null);

  const [emailError, setEmailError] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [emailValid, setEmailValid] = useState(false);
  const [passwordValid, setPasswordValid] = useState(false);

  const passwordRef = useRef<TextInput>(null);
  const scrollRef = useRef<ScrollView>(null);

  const validateEmailField = (value: string) => {
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

  const validatePasswordField = (value: string) => {
    if (!value) {
      setPasswordError('');
      setPasswordValid(false);
      return false;
    }
    const err = passwordValidationError(value);
    if (err) {
      setPasswordError(err);
      setPasswordValid(false);
      return false;
    }
    setPasswordError('');
    setPasswordValid(true);
    return true;
  };

  const isFormValid = emailValid && passwordValid;

  const handleLogin = async () => {
    const emailOk = validateEmailField(email);
    const passwordOk = validatePasswordField(password);

    if (!emailOk || !passwordOk) return;

    setLoading(true);
    try {
      const result = await authService.signInWithEmail(email.trim().toLowerCase(), password);

      if (!result.success) {
        Alert.alert('Login Failed', result.error || 'Invalid email or password. Please try again.');
        return;
      }

      // No manual navigation here — AppNavigator's root-level auth listener
      // detects the new session and routes to Main (or the mandatory PIN
      // setup gate, if this account somehow doesn't have one yet) on its own.
    } catch (error: any) {
      Alert.alert('Login Failed', error.message || 'Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const getFieldStyle = (hasError: boolean, isFocused: boolean) => {
    if (hasError) return styles.inputError;
    if (isFocused) return styles.inputFocused;
    return null;
  };

  return (
    <SafeAreaView edges={['top']} style={styles.container}>
      <KeyboardAvoidingView style={styles.keyboardView} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.header}>
          <TouchableOpacity
            style={styles.backButton}
            activeOpacity={0.7}
            onPress={() => { Keyboard.dismiss(); navigation.goBack(); }}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Text style={styles.backArrow}>‹</Text>
          </TouchableOpacity>
          <View style={styles.brandRow}>
            <View style={styles.brandTile}>
              <Image source={require('../../assets/icon-green.png')} style={styles.brandTileImg} resizeMode="contain" />
            </View>
            <Text style={styles.brandName}>KaysPay</Text>
          </View>
          <Text style={styles.title}>Welcome back</Text>
          <Text style={styles.subtitle}>Log in to manage your wallet</Text>
        </View>

        <ScrollView
          ref={scrollRef}
          style={styles.scrollView}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.formCard}>
            {/* Email */}
            <View style={styles.fieldContainer}>
              <Text style={styles.label}>
                Email Address<Text style={styles.required}> *</Text>
              </Text>
              <View style={[styles.inputWrapper, getFieldStyle(!!emailError, focusedField === 'email')]}>
                <Ionicons name="mail-outline" size={18} color={theme.inkMuted} style={styles.fieldIconIonicon} />
                <TextInput
                  style={styles.input}
                  placeholder="example@gmail.com"
                  placeholderTextColor={theme.inkMuted}
                  value={email}
                  onChangeText={(text) => {
                    setEmail(text);
                    validateEmailField(text);
                  }}
                  onFocus={() => setFocusedField('email')}
                  onBlur={() => setFocusedField(null)}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoCorrect={false}
                  returnKeyType="next"
                  onSubmitEditing={() => passwordRef.current?.focus()}
                />
                {email.length > 0 && !emailError && (
                  <Ionicons name="checkmark-circle" size={18} color={theme.brand} style={styles.statusIcon} />
                )}
                {emailError ? <Ionicons name="close-circle" size={18} color={theme.down} style={styles.statusIcon} /> : null}
              </View>
              {emailError ? <Text style={styles.errorText}>{emailError}</Text> : null}
            </View>

            {/* Password */}
            <View style={styles.fieldContainer}>
              <Text style={styles.label}>
                Password<Text style={styles.required}> *</Text>
              </Text>
              <View style={[styles.inputWrapper, getFieldStyle(!!passwordError, focusedField === 'password')]}>
                <Ionicons name="lock-closed-outline" size={18} color={theme.inkMuted} style={styles.fieldIconIonicon} />
                <TextInput
                  ref={passwordRef}
                  style={styles.input}
                  placeholder="Enter your password"
                  placeholderTextColor={theme.inkMuted}
                  value={password}
                  onChangeText={(text) => {
                    setPassword(text);
                    validatePasswordField(text);
                  }}
                  onFocus={() => {
                    setFocusedField('password');
                    scrollRef.current?.scrollToEnd({ animated: true });
                  }}
                  onBlur={() => setFocusedField(null)}
                  secureTextEntry={!showPassword}
                  autoCapitalize="none"
                  autoCorrect={false}
                  returnKeyType="done"
                  onSubmitEditing={handleLogin}
                />
                <TouchableOpacity
                  onPress={() => setShowPassword(!showPassword)}
                  activeOpacity={0.7}
                  style={styles.eyeButton}
                >
                  <Ionicons name={showPassword ? 'eye-off-outline' : 'eye-outline'} size={18} color={theme.inkMuted} />
                </TouchableOpacity>
              </View>
              {passwordError ? <Text style={styles.errorText}>{passwordError}</Text> : null}
            </View>
          </View>

          {/* Login Button */}
          <TouchableOpacity
            style={[styles.loginButton, (!isFormValid || loading) && styles.loginButtonDisabled]}
            onPress={handleLogin}
            disabled={!isFormValid || loading}
            activeOpacity={0.8}
          >
            <Text style={styles.loginButtonText}>
              {loading ? 'Logging in...' : 'Log in'}
            </Text>
          </TouchableOpacity>

          {/* Forgot Password */}
          <TouchableOpacity
            style={styles.forgotLink}
            activeOpacity={0.7}
            onPress={() => navigation.navigate('ForgotPassword')}
          >
            <Text style={styles.forgotText}>Forgot password?</Text>
          </TouchableOpacity>

          {/* Sign Up Link */}
          <TouchableOpacity
            style={styles.signupLink}
            onPress={() => navigation.navigate('Registration')}
            activeOpacity={0.7}
          >
            <Text style={styles.signupLinkText}>
              Don't have an account? <Text style={styles.signupLinkBold}>Sign Up</Text>
            </Text>
          </TouchableOpacity>

          {/* Terms */}
          <Text style={styles.terms}>
            By logging in, you agree to our{' '}
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
  container: {
    flex: 1,
    backgroundColor: theme.background,
  },
  keyboardView: {
    flex: 1,
  },
  header: {
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 16,
    zIndex: 10,
  },
  backButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: theme.surfaceRaised,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 16,
  },
  backArrow: {
    fontSize: 22,
    color: theme.ink,
    fontWeight: '600',
  },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 22,
  },
  brandTile: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: theme.brand,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 10,
    overflow: 'hidden',
  },
  brandTileImg: {
    width: 40,
    height: 40,
  },
  brandName: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 15,
    color: theme.ink,
  },
  title: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 26,
    color: theme.ink,
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 14,
    color: theme.inkMuted,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 16,
    paddingBottom: 40,
  },
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
  fieldContainer: {
    marginBottom: 20,
  },
  label: {
    fontSize: 13,
    color: theme.ink,
    fontWeight: '500',
    marginBottom: 6,
  },
  required: {
    color: theme.down,
  },
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
  inputFocused: {
    borderColor: theme.brand,
    backgroundColor: theme.surfaceRaised2,
    borderWidth: 2,
  },
  inputError: {
    borderColor: theme.down,
  },
  fieldIconIonicon: {
    marginRight: 10,
  },
  input: {
    flex: 1,
    fontSize: 15,
    color: theme.ink,
    padding: 0,
  },
  statusIcon: {
    marginLeft: 8,
  },
  errorText: {
    fontSize: 11,
    color: theme.down,
    marginTop: 6,
    marginLeft: 4,
  },
  eyeButton: {
    padding: 4,
    marginLeft: 8,
  },
  loginButton: {
    height: 56,
    backgroundColor: theme.brand,
    borderRadius: 14,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 8,
    marginBottom: 16,
  },
  loginButtonDisabled: {
    opacity: 0.6,
  },
  loginButtonText: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 16,
    color: '#FFFFFF',
  },
  forgotLink: {
    alignItems: 'center',
    marginBottom: 20,
  },
  forgotText: {
    fontSize: 14,
    color: theme.brand,
    fontWeight: '600',
  },
  signupLink: {
    alignItems: 'center',
    marginBottom: 24,
  },
  signupLinkText: {
    fontSize: 14,
    color: theme.inkMuted,
  },
  signupLinkBold: {
    color: theme.brand,
    fontWeight: '700',
    textDecorationLine: 'underline',
  },
  terms: {
    fontSize: 11,
    color: theme.inkMuted,
    textAlign: 'center',
    lineHeight: 16,
  },
  termsLink: {
    color: theme.brand,
    fontWeight: '600',
  },
  });
}
