import React, { useState } from 'react';
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
import { Colors } from '../constants/colors';
import { Typography } from '../constants/typography';
import { Spacing } from '../constants/spacing';
import { Strings } from '../constants/strings';
import { validateNigerianPhone } from '../utils/detectNetwork';
import { authService } from '../services/auth.service';


interface PhoneInputScreenProps {
  navigation: any;
}

export default function PhoneInputScreen({ navigation }: PhoneInputScreenProps) {
  const [phone, setPhone] = useState('');
  const [loading, setLoading] = useState(false);

  const handlePhoneChange = (text: string) => {
    const cleaned = text.replace(/[^0-9]/g, '');
    setPhone(cleaned);
  };

  const isValid = validateNigerianPhone(phone);

  const handleSendOTP = async () => {
    if (!isValid) {
      Alert.alert('Invalid Phone', Strings.ERROR_INVALID_PHONE);
      return;
    }

    setLoading(true);
    try {
      const formattedPhone = `+234${phone.slice(1)}`;

      const result = await authService.sendOTP(formattedPhone);

      if (!result.success) {
        Alert.alert('Error', result.error || Strings.ERROR_GENERIC);
        return;
      }

      navigation.navigate('OTPVerify', { phone: formattedPhone });
    } catch (error: any) {
      Alert.alert('Error', error.message || Strings.ERROR_GENERIC);
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView edges={['top']} style={styles.container}>
      <KeyboardAvoidingView
        style={styles.keyboardView}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <View style={styles.content}>
          <TouchableOpacity
            style={styles.backButton}
            activeOpacity={0.6}
            onPress={() => navigation.navigate('Welcome')}
          >
            <Text style={styles.backText}>{'<'}</Text>
          </TouchableOpacity>

          <Text style={styles.title}>{Strings.PHONE_INPUT_TITLE}</Text>
          <Text style={styles.subtitle}>{Strings.PHONE_INPUT_SUBTITLE}</Text>

          <View style={styles.inputContainer}>
            <View style={styles.countryCode}>
              <Text style={styles.flag}>🇳🇬</Text>
              <Text style={styles.code}>+234</Text>
            </View>
            <TextInput
              style={styles.input}
              value={phone}
              onChangeText={handlePhoneChange}
              placeholder={Strings.PHONE_INPUT_PLACEHOLDER}
              placeholderTextColor={Colors.GRAY}
              keyboardType="phone-pad"
              maxLength={11}
              autoFocus
            />
          </View>

          {phone.length > 0 && !isValid && (
            <Text style={styles.hint}>
              Enter a valid 11-digit Nigerian number (e.g., 08031234567)
            </Text>
          )}

          <TouchableOpacity
            style={[styles.button, !isValid && styles.buttonDisabled]}
            onPress={handleSendOTP}
            disabled={!isValid || loading}
          >
            <Text style={styles.buttonText}>
              {loading ? 'Sending...' : Strings.PHONE_INPUT_BUTTON}
            </Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.WHITE,
  },
  keyboardView: {
    flex: 1,
  },
  content: {
    flex: 1,
    paddingHorizontal: Spacing.SCREEN_PADDING,
    paddingTop: Spacing.M,
  },
  backButton: {
    width: 48,
    height: 48,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: Spacing.XL,
  },
  backText: {
    fontSize: 28,
    fontWeight: '600',
    color: Colors.DARK,
  },
  title: {
    ...Typography.SCREEN_TITLE,
    marginBottom: Spacing.S,
  },
  subtitle: {
    ...Typography.BODY,
    color: Colors.GRAY,
    marginBottom: Spacing.XL,
  },
  inputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: Spacing.INPUT_BORDER_WIDTH,
    borderColor: Colors.BORDER,
    borderRadius: Spacing.BUTTON_RADIUS,
    height: Spacing.INPUT_HEIGHT,
    paddingHorizontal: Spacing.M,
    marginBottom: Spacing.S,
  },
  countryCode: {
    flexDirection: 'row',
    alignItems: 'center',
    marginRight: Spacing.M,
    paddingRight: Spacing.M,
    borderRightWidth: 1,
    borderRightColor: Colors.BORDER,
  },
  flag: {
    fontSize: 20,
    marginRight: Spacing.XS,
  },
  code: {
    ...Typography.BODY,
    color: Colors.DARK,
  },
  input: {
    flex: 1,
    height: '100%',
    ...Typography.BODY,
    color: Colors.DARK,
  },
  hint: {
    ...Typography.CAPTION,
    color: Colors.RED,
    marginBottom: Spacing.M,
  },
  button: {
    height: Spacing.BUTTON_HEIGHT_PRIMARY,
    backgroundColor: Colors.GREEN,
    borderRadius: Spacing.BUTTON_RADIUS,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: Spacing.L,
  },
  buttonDisabled: {
    backgroundColor: Colors.GRAY,
  },
  buttonText: {
    ...Typography.BUTTON_TEXT,
  },
});
