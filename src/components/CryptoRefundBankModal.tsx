import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  Modal,
  FlatList,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { AppTheme } from '../constants/theme';
import { useTheme } from './ThemeProvider';
import { Typography } from '../constants/typography';
import { Spacing } from '../constants/spacing';
import { formatNaira } from '../utils/formatCurrency';
import { cryptoService } from '../services/crypto.service';

interface CryptoRefundBankModalProps {
  visible: boolean;
  transactionId: string;
  amountNgn: number;
  onClose: () => void;
  onSubmitted: () => void;
}

type VerifyState = 'idle' | 'checking' | 'verified' | 'failed';
type SubmitState = 'idle' | 'submitting' | 'done' | 'error';

/**
 * Collects and submits the customer's own bank account for a Buy Quidax
 * auto-refunded (the paying account's name didn't match). Deliberately mirrors
 * TransferScreen's bank-picker + debounced-verify shape rather than inventing
 * a new pattern — same trust discipline (never send anywhere unverified),
 * same UX a customer has already seen if they've used Transfer.
 */
export default function CryptoRefundBankModal({
  visible,
  transactionId,
  amountNgn,
  onClose,
  onSubmitted,
}: CryptoRefundBankModalProps) {
  const { theme } = useTheme();
  const styles = createStyles(theme);

  const [banks, setBanks] = useState<{ code: string; name: string }[]>([]);
  const [banksLoading, setBanksLoading] = useState(true);
  const [pickerVisible, setPickerVisible] = useState(false);
  const [bankSearch, setBankSearch] = useState('');
  const [selectedBank, setSelectedBank] = useState<{ code: string; name: string } | null>(null);

  const [accountNumber, setAccountNumber] = useState('');
  const [verifyState, setVerifyState] = useState<VerifyState>('idle');
  const [verifiedName, setVerifiedName] = useState<string | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);

  const [submitState, setSubmitState] = useState<SubmitState>('idle');
  const [submitError, setSubmitError] = useState('');

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setBanksLoading(true);
    cryptoService.listRefundBanks().then((list) => {
      if (cancelled) return;
      setBanksLoading(false);
      setBanks(list);
    });
    return () => { cancelled = true; };
  }, [visible]);

  const filteredBanks = useMemo(() => {
    const q = bankSearch.trim().toLowerCase();
    if (!q) return banks;
    return banks.filter((b) => b.name.toLowerCase().includes(q));
  }, [banks, bankSearch]);

  const handleSelectBank = useCallback((bank: { code: string; name: string }) => {
    setSelectedBank(bank);
    setPickerVisible(false);
    setBankSearch('');
    setVerifyState('idle');
    setVerifiedName(null);
    setVerifyError(null);
  }, []);

  const handleAccountNumberChange = useCallback((text: string) => {
    setAccountNumber(text.replace(/[^0-9]/g, '').slice(0, 10));
    setVerifyState('idle');
    setVerifiedName(null);
    setVerifyError(null);
  }, []);

  useEffect(() => {
    if (!selectedBank || accountNumber.length !== 10) return;
    const handle = setTimeout(async () => {
      setVerifyState('checking');
      const res = await cryptoService.resolveRefundAccount(transactionId, selectedBank.code, accountNumber);
      setVerifyState((current) => {
        if (current !== 'checking') return current;
        return res.success ? 'verified' : 'failed';
      });
      if (res.success) {
        setVerifiedName(res.accountName || null);
      } else {
        setVerifyError(res.error || 'Could not verify this account.');
      }
    }, 700);
    return () => clearTimeout(handle);
  }, [selectedBank, accountNumber, transactionId]);

  const canSubmit = !!selectedBank && verifyState === 'verified' && submitState !== 'submitting';

  const handleSubmit = useCallback(async () => {
    if (!canSubmit || !selectedBank) return;
    setSubmitState('submitting');
    setSubmitError('');
    const res = await cryptoService.submitRefundBank(transactionId, selectedBank.code, accountNumber);
    if (!res.success) {
      setSubmitState('error');
      setSubmitError(res.error || 'Could not submit your refund details. Please try again.');
      return;
    }
    setSubmitState('done');
  }, [canSubmit, selectedBank, transactionId, accountNumber]);

  const handleClose = useCallback(() => {
    if (submitState === 'done') onSubmitted();
    onClose();
    // Reset for next time this modal opens (a different refund, potentially).
    setSelectedBank(null);
    setAccountNumber('');
    setVerifyState('idle');
    setVerifiedName(null);
    setSubmitState('idle');
    setSubmitError('');
  }, [submitState, onSubmitted, onClose]);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={handleClose}>
      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Refund Bank Details</Text>
          <TouchableOpacity onPress={handleClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Ionicons name="close" size={22} color={theme.ink} />
          </TouchableOpacity>
        </View>

        {submitState === 'done' ? (
          <View style={styles.doneContainer}>
            <View style={styles.doneIcon}>
              <Ionicons name="checkmark" size={30} color="#FFFFFF" />
            </View>
            <Text style={styles.doneTitle}>Details Submitted</Text>
            <Text style={styles.doneDetail}>
              We've sent your bank details to our payment provider. Your {formatNaira(amountNgn)} refund
              should land within a few business days.
            </Text>
            <TouchableOpacity style={styles.primaryButton} onPress={handleClose}>
              <Text style={styles.primaryButtonText}>Done</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.body}>
            <Text style={styles.explainer}>
              Your last crypto purchase ({formatNaira(amountNgn)}) couldn't be completed because the paying bank
              account didn't match your KaysPay name. Our provider is refunding it — tell us where to send it.
            </Text>

            <View style={styles.section}>
              <Text style={styles.label}>Bank</Text>
              <TouchableOpacity
                style={styles.bankSelect}
                onPress={() => setPickerVisible(true)}
                activeOpacity={0.7}
                disabled={banksLoading || submitState === 'submitting'}
              >
                {banksLoading ? (
                  <ActivityIndicator size="small" color={theme.inkMuted} />
                ) : (
                  <Text style={selectedBank ? styles.bankSelectText : styles.bankSelectPlaceholder}>
                    {selectedBank ? selectedBank.name : 'Choose a bank'}
                  </Text>
                )}
                <Ionicons name="chevron-down" size={16} color={theme.inkMuted} />
              </TouchableOpacity>
            </View>

            <View style={styles.section}>
              <Text style={styles.label}>Account Number</Text>
              <TextInput
                style={styles.input}
                value={accountNumber}
                onChangeText={handleAccountNumberChange}
                placeholder="10-digit account number"
                placeholderTextColor={theme.inkMuted}
                keyboardType="number-pad"
                maxLength={10}
                editable={submitState !== 'submitting'}
              />
              {verifyState === 'checking' && (
                <View style={styles.verifyRow}>
                  <ActivityIndicator size="small" color={theme.inkMuted} />
                  <Text style={styles.verifyCheckingText}>Verifying account…</Text>
                </View>
              )}
              {verifyState === 'verified' && verifiedName && (
                <View style={styles.verifiedCard}>
                  <View style={styles.verifiedHeading}>
                    <View style={styles.verifiedIcon}>
                      <Ionicons name="checkmark" size={14} color="#FFFFFF" />
                    </View>
                    <Text style={styles.verifiedTitle}>Account verified</Text>
                  </View>
                  <Text style={styles.verifiedName}>{verifiedName}</Text>
                </View>
              )}
              {verifyState === 'failed' && (
                <Text style={styles.verifyFailedText}>{verifyError || 'Could not verify this account.'}</Text>
              )}
            </View>

            {submitError ? <Text style={styles.submitError}>{submitError}</Text> : null}

            <TouchableOpacity
              style={[styles.primaryButton, !canSubmit && styles.primaryButtonDisabled]}
              onPress={handleSubmit}
              disabled={!canSubmit}
            >
              {submitState === 'submitting' ? (
                <ActivityIndicator color="#FFFFFF" size="small" />
              ) : (
                <Text style={styles.primaryButtonText}>Submit for Refund</Text>
              )}
            </TouchableOpacity>
          </View>
        )}
      </SafeAreaView>

      <Modal visible={pickerVisible} animationType="slide" onRequestClose={() => setPickerVisible(false)}>
        <SafeAreaView style={styles.container}>
          <View style={styles.header}>
            <Text style={styles.headerTitle}>Select Bank</Text>
            <TouchableOpacity onPress={() => setPickerVisible(false)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name="close" size={22} color={theme.ink} />
            </TouchableOpacity>
          </View>
          <TextInput
            style={styles.pickerSearch}
            value={bankSearch}
            onChangeText={setBankSearch}
            placeholder="Search bank..."
            placeholderTextColor={theme.inkMuted}
            autoFocus
          />
          <FlatList
            data={filteredBanks}
            keyExtractor={(b) => b.code}
            renderItem={({ item }) => (
              <TouchableOpacity style={styles.pickerRow} onPress={() => handleSelectBank(item)} activeOpacity={0.7}>
                <Text style={styles.pickerRowText}>{item.name}</Text>
              </TouchableOpacity>
            )}
            ListEmptyComponent={<Text style={styles.pickerEmptyText}>No matching bank.</Text>}
            keyboardShouldPersistTaps="handled"
          />
        </SafeAreaView>
      </Modal>
    </Modal>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.background },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: Spacing.SCREEN_PADDING,
      paddingVertical: Spacing.M,
      borderBottomWidth: 1,
      borderBottomColor: theme.border,
    },
    headerTitle: { ...Typography.SECTION_HEADING, color: theme.ink },
    body: { flex: 1, padding: Spacing.SCREEN_PADDING },
    explainer: { ...Typography.BODY, color: theme.inkMuted, marginBottom: Spacing.XL, lineHeight: 20 },
    section: { marginBottom: Spacing.XL },
    label: { ...Typography.SECTION_HEADING, color: theme.ink, marginBottom: Spacing.M },
    bankSelect: {
      height: Spacing.INPUT_HEIGHT,
      borderWidth: Spacing.INPUT_BORDER_WIDTH,
      borderColor: theme.border,
      borderRadius: Spacing.BUTTON_RADIUS,
      paddingHorizontal: Spacing.L,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    bankSelectText: { ...Typography.BODY, color: theme.ink },
    bankSelectPlaceholder: { ...Typography.BODY, color: theme.inkMuted },
    input: {
      height: Spacing.INPUT_HEIGHT,
      borderWidth: Spacing.INPUT_BORDER_WIDTH,
      borderColor: theme.border,
      borderRadius: Spacing.BUTTON_RADIUS,
      paddingHorizontal: Spacing.L,
      ...Typography.BODY,
      color: theme.ink,
    },
    verifyRow: { flexDirection: 'row', alignItems: 'center', marginTop: Spacing.S },
    verifyCheckingText: { ...Typography.CAPTION, color: theme.inkMuted, marginLeft: Spacing.S },
    verifiedCard: {
      marginTop: Spacing.M,
      padding: Spacing.L,
      borderRadius: Spacing.CARD_RADIUS,
      backgroundColor: theme.brandSoft,
    },
    verifiedHeading: { flexDirection: 'row', alignItems: 'center', gap: Spacing.S },
    verifiedIcon: {
      width: 24,
      height: 24,
      borderRadius: 12,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.brand,
    },
    verifiedTitle: { ...Typography.CAPTION, color: theme.brand, fontWeight: '700' },
    verifiedName: { ...Typography.BODY, color: theme.ink, marginTop: Spacing.S },
    verifyFailedText: { ...Typography.CAPTION, color: theme.down, marginTop: Spacing.S },
    submitError: { ...Typography.ERROR, marginBottom: Spacing.M },
    primaryButton: {
      height: Spacing.BUTTON_HEIGHT_PRIMARY,
      backgroundColor: theme.brand,
      borderRadius: Spacing.BUTTON_RADIUS,
      justifyContent: 'center',
      alignItems: 'center',
      marginTop: Spacing.M,
    },
    primaryButtonDisabled: { opacity: 0.4 },
    primaryButtonText: { ...Typography.BUTTON_TEXT, color: '#FFFFFF' },
    doneContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: Spacing.SCREEN_PADDING },
    doneIcon: {
      width: 64,
      height: 64,
      borderRadius: 32,
      backgroundColor: theme.brand,
      justifyContent: 'center',
      alignItems: 'center',
      marginBottom: Spacing.XL,
    },
    doneTitle: { ...Typography.SCREEN_TITLE, color: theme.ink, marginBottom: Spacing.M },
    doneDetail: { ...Typography.BODY, color: theme.inkMuted, textAlign: 'center', marginBottom: Spacing.XL, lineHeight: 20 },
    pickerSearch: {
      margin: Spacing.L,
      height: Spacing.INPUT_HEIGHT,
      borderWidth: Spacing.INPUT_BORDER_WIDTH,
      borderColor: theme.border,
      borderRadius: Spacing.BUTTON_RADIUS,
      paddingHorizontal: Spacing.L,
      ...Typography.BODY,
      color: theme.ink,
    },
    pickerRow: {
      paddingHorizontal: Spacing.L,
      paddingVertical: Spacing.L,
      borderBottomWidth: 1,
      borderBottomColor: theme.border,
    },
    pickerRowText: { ...Typography.BODY, color: theme.ink },
    pickerEmptyText: { ...Typography.CAPTION, color: theme.inkMuted, textAlign: 'center', marginTop: Spacing.XL },
  });
}
