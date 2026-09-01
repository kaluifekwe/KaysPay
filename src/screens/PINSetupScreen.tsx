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
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AppTheme } from '../constants/theme';
import { useTheme } from '../components/ThemeProvider';
import { Typography } from '../constants/typography';
import { Spacing } from '../constants/spacing';
import { Strings } from '../constants/strings';
import { authService } from '../services/auth.service';

interface PINSetupScreenProps {
  navigation: any;
}

// Deliberately no screenshot protection here — every digit is rendered via
// secureTextEntry (masked dots), never plaintext, so there's nothing a
// screenshot could expose. Blocking it anyway only stopped users from
// reporting real errors at exactly this step, right after signup.
export default function PINSetupScreen({ navigation }: PINSetupScreenProps) {
  const { theme } = useTheme();
  const styles = createStyles(theme);
  const [pin, setPin] = useState(['', '', '', '']);
  const [confirmPin, setConfirmPin] = useState(['', '', '', '']);
  const [isConfirming, setIsConfirming] = useState(false);
  const [loading, setLoading] = useState(false);
  const inputRefs = useRef<(TextInput | null)[]>([]);

  const currentPin = isConfirming ? confirmPin : pin;
  const setCurrentPin = isConfirming ? setConfirmPin : setPin;

  useEffect(() => {
    inputRefs.current[0]?.focus();
  }, [isConfirming]);

  const handlePinChange = (text: string, index: number) => {
    const newPin = [...currentPin];
    newPin[index] = text;
    setCurrentPin(newPin);

    if (text && index < 3) {
      inputRefs.current[index + 1]?.focus();
    }

    if (newPin.every((d) => d !== '')) {
      if (!isConfirming) {
        setTimeout(() => {
          setIsConfirming(true);
        }, 300);
      } else {
        handleVerifyPINs(newPin);
      }
    }
  };

  const handleKeyPress = (key: string, index: number) => {
    if (key === 'Backspace' && !currentPin[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
  };

  const handleVerifyPINs = async (confirmedPin: string[]) => {
    const pinString = pin.join('');
    const confirmPinString = confirmedPin.join('');

    if (pinString !== confirmPinString) {
      Alert.alert('PIN Mismatch', Strings.PIN_MISMATCH);
      setPin(['', '', '', '']);
      setConfirmPin(['', '', '', '']);
      setIsConfirming(false);
      return;
    }

    setLoading(true);
    try {
      const result = await authService.savePIN(pinString);

      if (!result.success) {
        Alert.alert('Error', result.error || Strings.ERROR_GENERIC);
        setPin(['', '', '', '']);
        setConfirmPin(['', '', '', '']);
        setIsConfirming(false);
        return;
      }

      navigation.replace('BiometricSetup', { pin: pinString });
    } catch (error: any) {
      Alert.alert('Error', error.message || Strings.ERROR_GENERIC);
      setPin(['', '', '', '']);
      setConfirmPin(['', '', '', '']);
      setIsConfirming(false);
    } finally {
      setLoading(false);
    }
  };

  const renderPINBoxes = (pinArray: string[], isConfirm: boolean) => (
    <View style={styles.pinContainer}>
      {pinArray.map((digit, index) => (
        <TextInput
          key={`${isConfirm ? 'confirm' : 'pin'}-${index}`}
          ref={(ref) => {
            inputRefs.current[index] = ref;
          }}
          style={[styles.pinBox, digit ? styles.pinBoxFilled : null]}
          value={digit}
          onChangeText={(text) => handlePinChange(text, index)}
          onKeyPress={({ nativeEvent }) => handleKeyPress(nativeEvent.key, index)}
          keyboardType="number-pad"
          maxLength={1}
          secureTextEntry
          autoFocus={index === 0 && !isConfirm}
        />
      ))}
    </View>
  );

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
            onPress={() => {
              if (isConfirming) {
                setIsConfirming(false);
                setConfirmPin(['', '', '', '']);
              } else {
                navigation.goBack();
              }
            }}
          >
            <Text style={styles.backText}>{'<'}</Text>
          </TouchableOpacity>

          <Text style={styles.title}>
            {isConfirming ? Strings.PIN_CONFIRM_TITLE : Strings.PIN_SETUP_TITLE}
          </Text>
          <Text style={styles.subtitle}>
            {isConfirming ? Strings.PIN_CONFIRM_SUBTITLE : Strings.PIN_SETUP_SUBTITLE}
          </Text>

          {renderPINBoxes(currentPin, isConfirming)}

          {loading && (
            <Text style={styles.loadingText}>Setting up your PIN...</Text>
          )}

          {!isConfirming && (
            <View style={styles.hintContainer}>
              <Text style={styles.hintText}>
                Your PIN will be used for transaction verification
              </Text>
            </View>
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
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  backButton: {
    width: 48,
    height: 48,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 24,
  },
  backText: {
    fontSize: 28,
    fontWeight: '600',
    color: theme.ink,
  },
  title: {
    ...Typography.SCREEN_TITLE,
    color: theme.ink,
    marginBottom: 8,
  },
  subtitle: {
    ...Typography.BODY,
    color: theme.inkMuted,
    marginBottom: 32,
  },
  pinContainer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 32,
  },
  pinBox: {
    width: 64,
    height: 72,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 12,
    textAlign: 'center',
    fontSize: 24,
    fontFamily: 'Helvetica-Bold',
    color: theme.ink,
    backgroundColor: theme.surfaceRaised,
  },
  pinBoxFilled: {
    borderColor: theme.brand,
    backgroundColor: theme.surface,
  },
  loadingText: {
    ...Typography.BODY,
    color: theme.brand,
    textAlign: 'center',
    marginTop: 16,
  },
  hintContainer: {
    marginTop: 32,
    padding: 12,
    backgroundColor: theme.surfaceRaised,
    borderRadius: 12,
  },
  hintText: {
    ...Typography.CAPTION,
    color: theme.inkMuted,
    textAlign: 'center',
  },
  });
}
