import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { kycService } from '../services/kyc.service';
import { safeErrorMessage } from '../utils/errorMessages';
import { useSensitiveScreenProtection } from '../hooks/useSensitiveScreenProtection';
import { AppTheme } from '../constants/theme';
import { useTheme } from '../components/ThemeProvider';

export default function KycScreen({ navigation }: any) {
  useSensitiveScreenProtection();
  const { theme } = useTheme();
  const styles = createStyles(theme);
  const [loading, setLoading] = useState(true);
  const [verified, setVerified] = useState(false);
  const [verifiedName, setVerifiedName] = useState<string | undefined>();

  const [nin, setNin] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useFocusEffect(
    useCallback(() => {
      loadStatus();
    }, []),
  );

  const loadStatus = async () => {
    setLoading(true);
    try {
      const status = await kycService.getStatus();
      setVerified(status.verified);
      setVerifiedName(status.verifiedName);
    } finally {
      setLoading(false);
    }
  };

  const handleVerify = async () => {
    if (nin.length !== 11) {
      setError('Enter a valid 11-digit NIN');
      return;
    }
    setError('');
    setSubmitting(true);
    try {
      const result = await kycService.verifyNin(nin);
      if (!result.success) {
        setError(safeErrorMessage(result.error, 'Could not verify this NIN. Please try again.'));
        return;
      }
      setVerified(true);
      setVerifiedName(result.verifiedName);
    } catch (e) {
      setError(safeErrorMessage(e, 'Could not verify this NIN. Please try again.'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SafeAreaView edges={['top']} style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => navigation.goBack()}
          activeOpacity={0.7}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Text style={styles.backButtonText}>{'‹'}</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Identity Verification</Text>
        <View style={styles.headerSpacer} />
      </View>

      {loading ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator color={theme.brand} size="large" />
        </View>
      ) : (
        <KeyboardAvoidingView style={styles.scrollView} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <ScrollView
            style={styles.scrollView}
            contentContainerStyle={styles.scrollContent}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'}
          >
          {verified ? (
            <View style={styles.verifiedCard}>
              <Text style={styles.verifiedIcon}>✓</Text>
              <Text style={styles.verifiedTitle}>You're Verified</Text>
              {!!verifiedName && <Text style={styles.verifiedName}>{verifiedName}</Text>}
              <Text style={styles.verifiedSubtitle}>
                Your identity has been confirmed via your NIN. Your profile name is locked to match.
              </Text>
            </View>
          ) : (
            <View style={styles.formCard}>
              <Text style={styles.title}>Verify Your Identity</Text>
              <Text style={styles.subtitle}>
                Optional, but recommended. Enter your 11-digit National Identification Number (NIN) to
                confirm your identity. Your profile name will be updated to match your NIN record.
              </Text>

              <Text style={styles.label}>NIN</Text>
              <TextInput
                style={[styles.input, !!error && styles.inputError]}
                value={nin}
                onChangeText={(t) => {
                  setNin(t.replace(/[^0-9]/g, '').slice(0, 11));
                  setError('');
                }}
                placeholder="Enter your 11-digit NIN"
                placeholderTextColor={theme.inkMuted}
                keyboardType="number-pad"
                maxLength={11}
              />
              {!!error && <Text style={styles.errorText}>{error}</Text>}

              <TouchableOpacity
                style={[styles.submitButton, (nin.length !== 11 || submitting) && styles.submitButtonDisabled]}
                onPress={handleVerify}
                disabled={nin.length !== 11 || submitting}
                activeOpacity={0.8}
              >
                {submitting ? (
                  <ActivityIndicator color="#FFFFFF" size="small" />
                ) : (
                  <Text style={styles.submitButtonText}>Verify</Text>
                )}
              </TouchableOpacity>
            </View>
          )}
          </ScrollView>
        </KeyboardAvoidingView>
      )}
    </SafeAreaView>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.background },
  loadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: theme.border,
  },
  backButton: { width: 44, height: 44, justifyContent: 'center', alignItems: 'center' },
  backButtonText: { fontSize: 28, fontWeight: '600', color: theme.ink },
  headerTitle: { fontFamily: 'Helvetica-Bold', fontSize: 18, color: theme.ink, flex: 1, textAlign: 'center' },
  headerSpacer: { width: 44 },
  scrollView: { flex: 1 },
  scrollContent: { padding: 16 },
  formCard: {
    backgroundColor: theme.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.border,
    padding: 20,
  },
  title: { fontFamily: 'Helvetica-Bold', fontSize: 18, color: theme.ink, marginBottom: 8 },
  subtitle: { fontSize: 13, color: theme.inkMuted, lineHeight: 19, marginBottom: 20 },
  label: { fontSize: 13, color: theme.ink, fontWeight: '600', marginBottom: 8 },
  input: {
    height: 52,
    borderWidth: 1.5,
    borderColor: theme.border,
    borderRadius: 10,
    paddingHorizontal: 14,
    fontSize: 16,
    letterSpacing: 1,
    color: theme.ink,
  },
  inputError: { borderColor: theme.down },
  errorText: { fontSize: 12, color: theme.down, marginTop: 6 },
  submitButton: {
    backgroundColor: theme.brand,
    height: 52,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 20,
  },
  submitButtonDisabled: { opacity: 0.5 },
  submitButtonText: { fontSize: 15, color: '#FFFFFF', fontWeight: '700' },
  verifiedCard: {
    backgroundColor: theme.brandSoft,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.brand,
    padding: 24,
    alignItems: 'center',
  },
  verifiedIcon: {
    fontSize: 32,
    color: theme.brand,
    fontWeight: '700',
    marginBottom: 8,
  },
  verifiedTitle: { fontFamily: 'Helvetica-Bold', fontSize: 18, color: theme.ink, marginBottom: 4 },
  verifiedName: { fontSize: 15, color: theme.brand, fontWeight: '700', marginBottom: 8 },
  verifiedSubtitle: { fontSize: 13, color: theme.inkMuted, textAlign: 'center', lineHeight: 19 },
  });
}
