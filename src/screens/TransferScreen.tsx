import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Modal,
  FlatList,
  ScrollView,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { AppTheme } from '../constants/theme';
import { useTheme } from '../components/ThemeProvider';
import { Typography } from '../constants/typography';
import { Spacing } from '../constants/spacing';
import { formatNaira } from '../utils/formatCurrency';
import { transferService, type TransferBank } from '../services/transfer.service';
import { useTransactionAuth } from '../components/TransactionAuthProvider';

interface TransferScreenProps {
  navigation: {
    goBack: () => void;
    navigate: (screen: string) => void;
    popToTop?: () => void;
  };
}

type VerifyState = 'idle' | 'checking' | 'verified' | 'failed';
type SendState = 'idle' | 'sending' | 'success' | 'error';

export default function TransferScreen({ navigation }: TransferScreenProps) {
  const { theme } = useTheme();
  const styles = createStyles(theme);
  const { authorize } = useTransactionAuth();
  const insets = useSafeAreaInsets();

  const [banks, setBanks] = useState<TransferBank[]>([]);
  const [banksLoading, setBanksLoading] = useState(true);
  const [banksError, setBanksError] = useState('');
  const [pickerVisible, setPickerVisible] = useState(false);
  const [bankSearch, setBankSearch] = useState('');
  const [selectedBank, setSelectedBank] = useState<TransferBank | null>(null);

  const [accountNumber, setAccountNumber] = useState('');
  const [verifyState, setVerifyState] = useState<VerifyState>('idle');
  const [verifiedName, setVerifiedName] = useState<string | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);

  const [amount, setAmount] = useState('');
  const scrollRef = useRef<ScrollView>(null);
  const [sendState, setSendState] = useState<SendState>('idle');
  const [resultMessage, setResultMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    let cancelled = false;
    transferService.listBanks().then((res) => {
      if (cancelled) return;
      setBanksLoading(false);
      if (!res.success) {
        setBanksError(res.error || 'Could not load the bank list.');
        return;
      }
      setBanks(res.banks);
    });
    return () => { cancelled = true; };
  }, []);

  const filteredBanks = useMemo(() => {
    const q = bankSearch.trim().toLowerCase();
    if (!q) return banks;
    return banks.filter((b) => b.name.toLowerCase().includes(q));
  }, [banks, bankSearch]);

  const handleSelectBank = useCallback((bank: TransferBank) => {
    setSelectedBank(bank);
    setPickerVisible(false);
    setBankSearch('');
    // A different bank invalidates whatever was verified for the old one.
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

  // Debounced auto-verify, same shape as ElectricityPayScreen's meter check.
  useEffect(() => {
    if (!selectedBank || accountNumber.length !== 10) return;
    const handle = setTimeout(async () => {
      setVerifyState('checking');
      const res = await transferService.resolveAccount(selectedBank.code, accountNumber);
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
  }, [selectedBank, accountNumber]);

  const numericAmount = useMemo(() => parseInt(amount, 10), [amount]);
  const isValidAmount = !isNaN(numericAmount) && numericAmount >= 100;
  const canSend = !!selectedBank && verifyState === 'verified' && isValidAmount && sendState !== 'sending';

  const payHint = useMemo(() => {
    if (sendState === 'sending') return null;
    if (!selectedBank) return 'Select a bank to continue';
    if (accountNumber.length !== 10) return 'Enter a 10-digit account number';
    if (verifyState === 'checking') return 'Verifying account…';
    if (verifyState === 'failed') return 'Could not verify this account';
    if (!isValidAmount) return 'Enter an amount of at least ₦100';
    return null;
  }, [sendState, selectedBank, accountNumber, verifyState, isValidAmount]);

  const handleSend = useCallback(async () => {
    if (!canSend || !selectedBank || !verifiedName) return;

    const authResult = await authorize({
      title: 'Confirm Transfer',
      amount: numericAmount,
      subtitle: `${selectedBank.name} · ${accountNumber} · ${verifiedName}`,
    });
    if (!authResult) return;

    setErrorMessage('');
    setSendState('sending');
    const res = await transferService.send({
      bankCode: selectedBank.code,
      bankName: selectedBank.name,
      accountNumber,
      amount: numericAmount,
      authToken: authResult.token,
    });
    if (!res.success) {
      setSendState('error');
      setErrorMessage(res.error || 'Transfer failed. Please try again.');
      return;
    }
    setResultMessage(res.message || "Your transfer is processing. You'll be notified once it completes.");
    setSendState('success');
  }, [canSend, selectedBank, verifiedName, accountNumber, numericAmount, authorize]);

  const goHome = useCallback(() => {
    if (navigation.popToTop) navigation.popToTop();
    else navigation.navigate('HomeTabs');
  }, [navigation]);

  if (sendState === 'success') {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <View style={styles.resultContainer}>
          <View style={styles.successIcon}>
            <Text style={styles.successIconText}>{'✓'}</Text>
          </View>
          <Text style={styles.resultTitle}>Transfer Processing</Text>
          <Text style={styles.resultDetail}>{resultMessage}</Text>
          <Text style={styles.resultDetail}>{selectedBank?.name} · {accountNumber}</Text>
          <Text style={styles.resultDetail}>{verifiedName}</Text>
          <Text style={styles.resultAmount}>{formatNaira(numericAmount)}</Text>
          <TouchableOpacity style={styles.primaryButton} onPress={goHome}>
            <Text style={styles.primaryButtonText}>Done</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          ref={scrollRef}
          style={styles.scrollView}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <TouchableOpacity style={styles.backButton} activeOpacity={0.6} onPress={() => navigation.goBack()}>
            <Text style={styles.backText}>{'<'}</Text>
          </TouchableOpacity>

          <Text style={styles.title}>Transfer</Text>

          <View style={styles.section}>
            <Text style={styles.label}>Bank</Text>
            <TouchableOpacity
              style={styles.bankSelect}
              onPress={() => setPickerVisible(true)}
              activeOpacity={0.7}
              disabled={banksLoading || sendState === 'sending'}
            >
              {banksLoading ? (
                <ActivityIndicator size="small" color={theme.inkMuted} />
              ) : (
                <Text style={selectedBank ? styles.bankSelectText : styles.bankSelectPlaceholder}>
                  {selectedBank ? selectedBank.name : 'Choose a bank'}
                </Text>
              )}
              <Text style={styles.bankSelectChevron}>▾</Text>
            </TouchableOpacity>
            {banksError ? <Text style={styles.amountError}>{banksError}</Text> : null}
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
              editable={sendState !== 'sending'}
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
                    <Ionicons name="checkmark" size={16} color="#FFFFFF" />
                  </View>
                  <Text style={styles.verifiedTitle}>Account verified</Text>
                </View>
                <Text style={styles.verifiedName}>{verifiedName}</Text>
              </View>
            )}
            {verifyState === 'failed' && (
              <View style={styles.verifyFailedBlock}>
                <Text style={styles.verifyFailedText}>{verifyError || 'Could not verify this account.'}</Text>
              </View>
            )}
          </View>

          <View style={styles.section}>
            <Text style={styles.label}>Amount</Text>
            <View style={styles.customAmountContainer}>
              <Text style={styles.currencySymbol}>{formatNaira(0).charAt(0)}</Text>
              <TextInput
                style={styles.amountInput}
                placeholder="Enter amount"
                placeholderTextColor={theme.inkMuted}
                value={amount}
                onChangeText={(t) => setAmount(t.replace(/[^0-9]/g, '').slice(0, 9))}
                keyboardType="numeric"
                editable={sendState !== 'sending'}
                onFocus={() => scrollRef.current?.scrollToEnd({ animated: true })}
              />
            </View>
            {numericAmount > 0 && !isValidAmount && (
              <Text style={styles.amountError}>Minimum transfer is ₦100</Text>
            )}
          </View>

          {errorMessage ? (
            <View style={styles.errorContainer}>
              <Text style={styles.errorText}>{errorMessage}</Text>
            </View>
          ) : null}
        </ScrollView>

        <View style={[styles.bottomContainer, { paddingBottom: insets.bottom + Spacing.SCREEN_PADDING }]}>
          {selectedBank && verifiedName && (
            <View style={styles.summaryContainer}>
              <Text style={styles.summaryText} numberOfLines={1}>
                {selectedBank.name} · {accountNumber} · {verifiedName}
              </Text>
            </View>
          )}
          {payHint && (
            <View style={styles.payHintRow}>
              <Text style={styles.payHintText}>{payHint}</Text>
            </View>
          )}
          <TouchableOpacity
            style={[styles.primaryButton, !canSend && styles.primaryButtonDisabled]}
            onPress={handleSend}
            disabled={!canSend}
            activeOpacity={0.8}
          >
            {sendState === 'sending' ? (
              <ActivityIndicator color="#FFFFFF" size="small" />
            ) : (
              <Text style={styles.primaryButtonText}>
                Send {numericAmount > 0 ? formatNaira(numericAmount) : ''}
              </Text>
            )}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>

      <Modal visible={pickerVisible} animationType="slide" onRequestClose={() => setPickerVisible(false)}>
        <SafeAreaView style={styles.container}>
          <View style={styles.pickerHeader}>
            <Text style={styles.pickerTitle}>Select Bank</Text>
            <TouchableOpacity onPress={() => setPickerVisible(false)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Text style={styles.pickerClose}>✕</Text>
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
    </SafeAreaView>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.background },
  flex: { flex: 1 },
  scrollView: { flex: 1 },
  scrollContent: {
    paddingHorizontal: Spacing.SCREEN_PADDING,
    paddingTop: Spacing.M,
    paddingBottom: 180,
  },
  backButton: {
    width: 48,
    height: 48,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: Spacing.XL,
  },
  backText: { fontSize: 28, fontWeight: '600', color: theme.ink },
  title: { ...Typography.SCREEN_TITLE, color: theme.ink, marginBottom: Spacing.L },
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
  bankSelectChevron: { fontSize: 13, color: theme.inkMuted },
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
  verifiedHeading: { flexDirection: 'row', alignItems: 'center', gap: Spacing.M },
  verifiedIcon: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.brand,
  },
  verifiedTitle: { ...Typography.BODY, color: theme.brand, fontWeight: '700' },
  verifiedName: { ...Typography.BODY, color: theme.ink, marginTop: Spacing.M },
  verifyFailedBlock: { marginTop: Spacing.S },
  verifyFailedText: { ...Typography.CAPTION, color: theme.down },
  customAmountContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    height: Spacing.INPUT_HEIGHT,
    borderWidth: Spacing.INPUT_BORDER_WIDTH,
    borderColor: theme.border,
    borderRadius: Spacing.BUTTON_RADIUS,
    paddingHorizontal: Spacing.L,
  },
  currencySymbol: { ...Typography.BODY, fontWeight: '600', color: theme.ink, marginRight: Spacing.S },
  amountInput: { flex: 1, ...Typography.BODY, color: theme.ink },
  amountError: { ...Typography.ERROR, marginTop: Spacing.S },
  errorContainer: { marginTop: Spacing.M },
  errorText: { ...Typography.ERROR },
  bottomContainer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    padding: Spacing.SCREEN_PADDING,
    backgroundColor: theme.surface,
    borderTopWidth: 1,
    borderTopColor: theme.border,
  },
  summaryContainer: {
    backgroundColor: theme.surfaceRaised,
    borderRadius: Spacing.CARD_RADIUS,
    padding: Spacing.CARD_PADDING,
    marginBottom: Spacing.M,
  },
  summaryText: { ...Typography.BODY, color: theme.ink },
  payHintRow: { marginBottom: Spacing.M, alignItems: 'center' },
  payHintText: { ...Typography.CAPTION, color: theme.inkMuted, textAlign: 'center' },
  primaryButton: {
    height: Spacing.BUTTON_HEIGHT_PRIMARY,
    backgroundColor: theme.brand,
    borderRadius: Spacing.BUTTON_RADIUS,
    justifyContent: 'center',
    alignItems: 'center',
  },
  primaryButtonDisabled: { backgroundColor: theme.inkFaint, opacity: 0.6 },
  primaryButtonText: { ...Typography.BUTTON_TEXT },
  resultContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: Spacing.SCREEN_PADDING },
  successIcon: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: theme.brand,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: Spacing.XL,
  },
  successIconText: { fontSize: 36, color: '#FFFFFF' },
  resultTitle: { ...Typography.SCREEN_TITLE, color: theme.ink, marginBottom: Spacing.M },
  resultDetail: { ...Typography.BODY, color: theme.inkMuted, marginBottom: Spacing.S, textAlign: 'center' },
  resultAmount: { ...Typography.AMOUNT_LARGE, color: theme.brand, marginTop: Spacing.L, marginBottom: Spacing.XL },
  pickerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.L,
    paddingVertical: Spacing.M,
    borderBottomWidth: 1,
    borderBottomColor: theme.border,
  },
  pickerTitle: { ...Typography.SCREEN_TITLE, color: theme.ink },
  pickerClose: { fontSize: 20, color: theme.ink, padding: Spacing.S },
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
