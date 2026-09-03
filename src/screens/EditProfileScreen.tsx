import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  Alert,
  ActivityIndicator,
  Modal,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Keyboard,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { withTimeout } from '../utils/network';
import { kycService } from '../services/kyc.service';
import { authService } from '../services/auth.service';
import { safeErrorMessage } from '../utils/errorMessages';
import { useTransactionAuth } from '../components/TransactionAuthProvider';
import { useSensitiveScreenProtection } from '../hooks/useSensitiveScreenProtection';
import { AppTheme } from '../constants/theme';
import { useTheme } from '../components/ThemeProvider';

type ChangeField = 'phone' | 'email';

// Phone/email changes require step-up security (owner decision, 2026-08-04,
// replacing an even stricter 2026-07-06 decision to lock them forever —
// this time with the missing piece: PIN/biometric step-up PLUS an OTP
// emailed to the account's current address before anything actually moves.
// See migration 077 and request-/confirm-profile-change edge functions.
// Adding a phone when none exists yet skips the OTP (nothing to protect).
function displayPhone(raw: string): string {
  const digits = raw.replace(/[^\d]/g, '');
  if (digits.startsWith('234') && digits.length === 13) return '0' + digits.slice(3);
  return digits;
}

export default function EditProfileScreen({ navigation }: any) {
  useSensitiveScreenProtection();
  const { authorize } = useTransactionAuth();
  const { theme } = useTheme();
  const styles = createStyles(theme);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [fullName, setFullName] = useState('');
  const [address, setAddress] = useState('');
  const [nameLocked, setNameLocked] = useState(false);

  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');

  const [editingField, setEditingField] = useState<ChangeField | null>(null);
  const [fieldInput, setFieldInput] = useState('');
  const [submittingField, setSubmittingField] = useState(false);

  const [otpVisible, setOtpVisible] = useState(false);
  const [otpField, setOtpField] = useState<ChangeField | null>(null);
  const [otpSentTo, setOtpSentTo] = useState('');
  const [otpCode, setOtpCode] = useState('');
  const [otpError, setOtpError] = useState<string | null>(null);
  const [otpSubmitting, setOtpSubmitting] = useState(false);

  useFocusEffect(
    useCallback(() => {
      loadUser();
    }, []),
  );

  const loadUser = async () => {
    setLoading(true);
    try {
      const [{ data: { user } }, kyc] = await Promise.all([
        withTimeout(supabase.auth.getUser()),
        kycService.getStatus(),
      ]);
      setFullName(user?.user_metadata?.full_name || '');
      setAddress(user?.user_metadata?.address || '');
      setNameLocked(kyc.verified);
      setPhone(displayPhone(String(user?.phone || user?.user_metadata?.phone || '')));
      setEmail(user?.email || '');
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    if (!fullName.trim()) {
      Alert.alert('Full name required', 'Please enter your full name.');
      return;
    }
    setSaving(true);
    try {
      const { error } = await supabase.auth.updateUser({
        data: { full_name: fullName.trim(), address: address.trim() },
      });
      if (error) throw error;
      Alert.alert('Saved', 'Your profile has been updated.');
      navigation.goBack();
    } catch (error: any) {
      Alert.alert('Error', safeErrorMessage(error, 'Could not save your changes. Please try again.'));
    } finally {
      setSaving(false);
    }
  };

  const startEditField = (field: ChangeField) => {
    setFieldInput(field === 'phone' ? phone : email);
    setEditingField(field);
  };

  const cancelEditField = () => {
    setEditingField(null);
    setFieldInput('');
  };

  const submitFieldChange = async () => {
    if (!editingField) return;
    const trimmed = fieldInput.trim();
    if (!trimmed) {
      Alert.alert(
        editingField === 'phone' ? 'Phone number required' : 'Email required',
        `Please enter a ${editingField === 'phone' ? 'phone number' : 'email address'}.`,
      );
      return;
    }
    if (editingField === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      Alert.alert('Invalid email', 'Please enter a valid email address.');
      return;
    }

    const authResult = await authorize({
      title: editingField === 'phone'
        ? (phone ? 'Confirm Phone Change' : 'Add Phone Number')
        : 'Confirm Email Change',
      subtitle: 'Enter your PIN to continue',
      skipBalanceCheck: true,
    });
    if (!authResult) return;

    setSubmittingField(true);
    try {
      const res = await authService.requestProfileChange(editingField, trimmed, authResult.token);
      if (!res.success) {
        Alert.alert('Error', res.error || 'Could not update this. Please try again.');
        return;
      }
      if (res.applied) {
        setPhone(displayPhone(trimmed));
        setEditingField(null);
        Alert.alert('Saved', 'Your phone number has been added.');
        return;
      }
      setEditingField(null);
      setOtpField(editingField);
      setOtpSentTo(res.sentTo || '');
      setOtpCode('');
      setOtpError(null);
      setOtpVisible(true);
    } finally {
      setSubmittingField(false);
    }
  };

  const closeOtp = () => {
    setOtpVisible(false);
    setOtpField(null);
    setOtpCode('');
    setOtpError(null);
  };

  const confirmOtp = async () => {
    if (!otpField) return;
    const code = otpCode.trim();
    if (!/^\d{6}$/.test(code)) {
      setOtpError('Enter the 6-digit code');
      return;
    }
    setOtpSubmitting(true);
    setOtpError(null);
    try {
      const res = await authService.confirmProfileChange(otpField, code);
      if (!res.success) {
        setOtpError(res.error || 'Incorrect code. Please try again.');
        return;
      }
      if (otpField === 'phone') setPhone(displayPhone(res.newValue || ''));
      else setEmail(res.newValue || '');
      const fieldLabel = otpField === 'phone' ? 'phone number' : 'email address';
      closeOtp();
      Alert.alert('Saved', `Your ${fieldLabel} has been updated.`);
    } finally {
      setOtpSubmitting(false);
    }
  };

  if (loading) {
    return (
      <SafeAreaView edges={['top']} style={styles.container}>
        <View style={styles.loadingContainer}>
          <ActivityIndicator color={theme.brand} size="large" />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView edges={['top']} style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => { Keyboard.dismiss(); navigation.goBack(); }}
          activeOpacity={0.7}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Text style={styles.backButtonText}>{'‹'}</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Edit Profile</Text>
        <View style={styles.headerSpacer} />
      </View>

      <KeyboardAvoidingView
        style={styles.scrollView}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          style={styles.scrollView}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
        >
        <View style={styles.fieldCard}>
          <Text style={styles.fieldLabel}>Full Name</Text>
          {nameLocked ? (
            <>
              <Text style={styles.fieldValue}>{fullName}</Text>
              <Text style={styles.helperText}>Verified via NIN — locked.</Text>
            </>
          ) : (
            <TextInput
              style={styles.input}
              value={fullName}
              onChangeText={setFullName}
              placeholder="Your full name"
              placeholderTextColor={theme.inkMuted}
              autoCapitalize="words"
              autoCorrect={false}
            />
          )}
        </View>

        <View style={styles.fieldCard}>
          <Text style={styles.fieldLabel}>Address</Text>
          <TextInput
            style={[styles.input, styles.multilineInput]}
            value={address}
            onChangeText={setAddress}
            placeholder="e.g. 12 Awolowo Road, Ikeja"
            placeholderTextColor={theme.inkMuted}
            multiline
            numberOfLines={2}
          />
        </View>

        <TouchableOpacity
          style={[styles.saveButton, saving && styles.saveButtonDisabled]}
          onPress={handleSave}
          disabled={saving}
          activeOpacity={0.8}
        >
          {saving ? (
            <ActivityIndicator color="#FFFFFF" size="small" />
          ) : (
            <Text style={styles.saveButtonText}>Save Changes</Text>
          )}
        </TouchableOpacity>

        <View style={styles.divider} />
        <Text style={styles.sectionHeading}>Security-sensitive details</Text>
        <Text style={styles.sectionSubtext}>
          Changing these requires your PIN or biometric, plus a code sent to your current email.
        </Text>

        <View style={styles.fieldCard}>
          <Text style={styles.fieldLabel}>Phone Number</Text>
          {editingField === 'phone' ? (
            <>
              <TextInput
                style={styles.input}
                value={fieldInput}
                onChangeText={setFieldInput}
                placeholder="e.g. 0803xxxxxxx"
                placeholderTextColor={theme.inkMuted}
                keyboardType="phone-pad"
                autoFocus
              />
              <View style={styles.editActionsRow}>
                <TouchableOpacity style={styles.cancelInlineButton} onPress={cancelEditField} disabled={submittingField}>
                  <Text style={styles.cancelInlineText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.confirmInlineButton, submittingField && styles.saveButtonDisabled]}
                  onPress={submitFieldChange}
                  disabled={submittingField}
                >
                  {submittingField ? (
                    <ActivityIndicator color="#FFFFFF" size="small" />
                  ) : (
                    <Text style={styles.confirmInlineText}>{phone ? 'Change' : 'Add'}</Text>
                  )}
                </TouchableOpacity>
              </View>
            </>
          ) : (
            <View style={styles.valueRow}>
              <Text style={styles.fieldValue}>{phone || 'Not set'}</Text>
              <TouchableOpacity onPress={() => startEditField('phone')} activeOpacity={0.7}>
                <Text style={styles.changeLink}>{phone ? 'Change' : 'Add'}</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>

        <View style={styles.fieldCard}>
          <Text style={styles.fieldLabel}>Email</Text>
          {editingField === 'email' ? (
            <>
              <TextInput
                style={styles.input}
                value={fieldInput}
                onChangeText={setFieldInput}
                placeholder="you@example.com"
                placeholderTextColor={theme.inkMuted}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                autoFocus
              />
              <View style={styles.editActionsRow}>
                <TouchableOpacity style={styles.cancelInlineButton} onPress={cancelEditField} disabled={submittingField}>
                  <Text style={styles.cancelInlineText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.confirmInlineButton, submittingField && styles.saveButtonDisabled]}
                  onPress={submitFieldChange}
                  disabled={submittingField}
                >
                  {submittingField ? (
                    <ActivityIndicator color="#FFFFFF" size="small" />
                  ) : (
                    <Text style={styles.confirmInlineText}>Change</Text>
                  )}
                </TouchableOpacity>
              </View>
            </>
          ) : (
            <View style={styles.valueRow}>
              <Text style={styles.fieldValue}>{email}</Text>
              <TouchableOpacity onPress={() => startEditField('email')} activeOpacity={0.7}>
                <Text style={styles.changeLink}>Change</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
        </ScrollView>
      </KeyboardAvoidingView>

      <Modal visible={otpVisible} transparent animationType="fade" onRequestClose={closeOtp}>
        <KeyboardAvoidingView
          style={styles.otpOverlay}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={styles.otpCard}>
            <Text style={styles.otpTitle}>Enter Verification Code</Text>
            <Text style={styles.otpSubtitle}>
              We sent a 6-digit code to {otpSentTo || 'your email'}. Enter it to confirm this change.
            </Text>
            <TextInput
              style={styles.otpInput}
              value={otpCode}
              onChangeText={(t) => setOtpCode(t.replace(/[^\d]/g, '').slice(0, 6))}
              placeholder="000000"
              placeholderTextColor={theme.inkMuted}
              keyboardType="number-pad"
              maxLength={6}
              autoFocus
            />
            {otpError && <Text style={styles.otpError}>{otpError}</Text>}
            <TouchableOpacity
              style={[styles.saveButton, otpSubmitting && styles.saveButtonDisabled]}
              onPress={confirmOtp}
              disabled={otpSubmitting}
              activeOpacity={0.8}
            >
              {otpSubmitting ? (
                <ActivityIndicator color="#FFFFFF" size="small" />
              ) : (
                <Text style={styles.saveButtonText}>Confirm</Text>
              )}
            </TouchableOpacity>
            <TouchableOpacity style={styles.otpCancel} onPress={closeOtp} disabled={otpSubmitting}>
              <Text style={styles.cancelInlineText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.background,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: theme.border,
  },
  backButton: {
    width: 44,
    height: 44,
    justifyContent: 'center',
    alignItems: 'center',
  },
  backButtonText: {
    fontSize: 28,
    fontWeight: '600',
    color: theme.ink,
  },
  headerTitle: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 18,
    color: theme.ink,
    flex: 1,
    textAlign: 'center',
  },
  headerSpacer: {
    width: 44,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    padding: 16,
    paddingBottom: 40,
  },
  fieldCard: {
    backgroundColor: theme.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.border,
    padding: 16,
    marginBottom: 16,
  },
  fieldLabel: {
    fontSize: 12,
    color: theme.inkMuted,
    fontWeight: '600',
    marginBottom: 8,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  fieldValue: {
    fontSize: 16,
    color: theme.ink,
    fontWeight: '500',
  },
  valueRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  changeLink: {
    fontSize: 14,
    fontWeight: '700',
    color: theme.brand,
  },
  input: {
    height: 48,
    borderWidth: 1.5,
    borderColor: theme.border,
    borderRadius: 10,
    paddingHorizontal: 14,
    fontSize: 15,
    color: theme.ink,
  },
  multilineInput: {
    height: 72,
    paddingTop: 12,
    textAlignVertical: 'top',
  },
  helperText: {
    fontSize: 12,
    color: theme.inkMuted,
    marginTop: 8,
    lineHeight: 17,
  },
  editActionsRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: 12,
    gap: 12,
  },
  cancelInlineButton: {
    height: 40,
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  cancelInlineText: {
    fontSize: 14,
    fontWeight: '600',
    color: theme.inkMuted,
  },
  confirmInlineButton: {
    height: 40,
    minWidth: 80,
    borderRadius: 10,
    backgroundColor: theme.brand,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 16,
  },
  confirmInlineText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  divider: {
    height: 1,
    backgroundColor: theme.border,
    marginVertical: 20,
  },
  sectionHeading: {
    fontSize: 14,
    fontWeight: '700',
    color: theme.ink,
    marginBottom: 4,
  },
  sectionSubtext: {
    fontSize: 12,
    color: theme.inkMuted,
    marginBottom: 16,
    lineHeight: 17,
  },
  saveButton: {
    backgroundColor: theme.brand,
    height: 52,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 8,
  },
  saveButtonDisabled: {
    opacity: 0.7,
  },
  saveButtonText: {
    fontSize: 15,
    color: '#FFFFFF',
    fontWeight: '700',
  },
  otpOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  otpCard: {
    backgroundColor: theme.surface,
    borderRadius: 16,
    padding: 24,
  },
  otpTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: theme.ink,
    textAlign: 'center',
  },
  otpSubtitle: {
    fontSize: 13,
    color: theme.inkMuted,
    textAlign: 'center',
    marginTop: 8,
    marginBottom: 20,
    lineHeight: 18,
  },
  otpInput: {
    height: 56,
    borderWidth: 1.5,
    borderColor: theme.border,
    borderRadius: 10,
    fontSize: 24,
    fontWeight: '700',
    textAlign: 'center',
    letterSpacing: 8,
    color: theme.ink,
  },
  otpError: {
    fontSize: 13,
    color: theme.down,
    textAlign: 'center',
    marginTop: 10,
  },
  otpCancel: {
    marginTop: 12,
    height: 40,
    justifyContent: 'center',
    alignItems: 'center',
  },
  });
}
