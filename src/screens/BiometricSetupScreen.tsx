import React, { useState } from 'react';
import {
  View,
  StyleSheet,
  Text,
  TouchableOpacity,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as LocalAuthentication from 'expo-local-authentication';
import { AppTheme } from '../constants/theme';
import { useTheme } from '../components/ThemeProvider';
import { authService } from '../services/auth.service';

interface BiometricSetupScreenProps {
  route: { params?: { pin?: string } };
  onComplete: () => void;
}

export default function BiometricSetupScreen({ route, onComplete }: BiometricSetupScreenProps) {
  const { theme } = useTheme();
  const styles = createStyles(theme);
  const [loading, setLoading] = useState(false);
  const pin = route.params?.pin;

  const handleEnableBiometric = async () => {
    if (loading) return;
    setLoading(true);
    try {
      const compatible = await LocalAuthentication.hasHardwareAsync();
      if (!compatible) {
        await handleSkip();
        return;
      }

      const enrolled = await LocalAuthentication.isEnrolledAsync();
      if (!enrolled) {
        await handleSkip();
        return;
      }

      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: 'Authenticate to enable biometric login',
        cancelLabel: 'Cancel',
        disableDeviceFallback: false,
      });

      if (result.success) {
        // Store the PIN behind a biometric-gated keychain entry so Face ID/
        // fingerprint can later unlock it for real server-side verification
        // — without this, biometric would just be a client-side toggle with
        // nothing to actually authorize a transaction with.
        if (pin) await authService.saveBiometricPin(pin);
        await authService.saveBiometric(true);
        onComplete();
      } else {
        await handleSkip();
      }
    } catch (error) {
      await handleSkip();
    } finally {
      setLoading(false);
    }
  };

  const handleSkip = async () => {
    try {
      await authService.saveBiometric(false);
    } catch (error) {
      // ignore
    }
    onComplete();
  };

  return (
    <SafeAreaView edges={['top']} style={styles.container}>
      <View style={styles.content}>
        <View style={styles.iconContainer}>
          <Text style={styles.icon}>🔐</Text>
        </View>

        <Text style={styles.title}>Enable Biometric Login</Text>
        <Text style={styles.subtitle}>Use fingerprint or face to{'\n'}log in quickly</Text>

        <View style={styles.buttonContainer}>
          <TouchableOpacity
            style={[styles.enableButton, loading && styles.enableButtonLoading]}
            onPress={handleEnableBiometric}
            activeOpacity={0.8}
          >
            <Text style={styles.enableButtonText}>
              {loading ? 'Setting up...' : 'Enable Biometric'}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.skipButton}
            onPress={handleSkip}
            activeOpacity={0.7}
          >
            <Text style={styles.skipButtonText}>Skip for now</Text>
          </TouchableOpacity>
        </View>
      </View>
    </SafeAreaView>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.background,
  },
  content: {
    flex: 1,
    paddingHorizontal: 24,
    justifyContent: 'center',
    alignItems: 'center',
  },
  iconContainer: {
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: theme.brandSoft,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 32,
  },
  icon: {
    fontSize: 48,
  },
  title: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 24,
    color: theme.ink,
    textAlign: 'center',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 15,
    color: theme.inkMuted,
    textAlign: 'center',
    marginBottom: 64,
    lineHeight: 22,
  },
  buttonContainer: {
    width: '100%',
    paddingHorizontal: 8,
  },
  enableButton: {
    height: 56,
    backgroundColor: theme.brand,
    borderRadius: 14,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 12,
  },
  enableButtonLoading: {
    opacity: 0.7,
  },
  enableButtonText: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 16,
    color: '#FFFFFF',
  },
  skipButton: {
    height: 48,
    justifyContent: 'center',
    alignItems: 'center',
  },
  skipButtonText: {
    fontSize: 15,
    color: theme.inkMuted,
  },
  });
}
