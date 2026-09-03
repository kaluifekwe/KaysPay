import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import {
  View,
  StyleSheet,
  Text,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  Keyboard,
  Alert,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { AppTheme } from '../constants/theme';
import { safeErrorMessage } from '../utils/errorMessages';
import { useTheme } from '../components/ThemeProvider';
import { Typography } from '../constants/typography';
import { Spacing } from '../constants/spacing';
import { formatNaira } from '../utils/formatCurrency';
import { vtuService, type ElectricityProvider, type SavedBillingAccount } from '../services/vtu.service';
import { useTransactionAuth } from '../components/TransactionAuthProvider';
import ProviderLogo from '../components/ProviderLogo';
import { ELECTRICITY_LOGOS } from '../utils/providerLogos';
import { downloadPdf, sharePdf } from '../utils/pdf';
import { buildElectricityReceiptHtml } from '../utils/receipts';

type BuyState = 'idle' | 'processing' | 'success' | 'error';
type VerifyState = 'idle' | 'checking' | 'verified' | 'failed';

const QUICK_AMOUNTS = [1000, 2000, 5000, 10000, 20000, 50000];

export default function ElectricityPayScreen(props: any) {
  const { navigation, route } = props;
  const { authorize } = useTransactionAuth();
  const { theme } = useTheme();
  const styles = createStyles(theme);
  const insets = useSafeAreaInsets();
  const provider = route.params.provider as ElectricityProvider;

  const [meterNumber, setMeterNumber] = useState('');
  const [amount, setAmount] = useState('');
  const [buyState, setBuyState] = useState<BuyState>('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const [resultToken, setResultToken] = useState<string | null>(null);
  const [resultUnits, setResultUnits] = useState<string | null>(null);
  const [resultPending, setResultPending] = useState(false);
  const [resultOrderId, setResultOrderId] = useState<string | null>(null);
  const [generatingPdf, setGeneratingPdf] = useState(false);
  // The custom-amount field sits near the bottom of the form, right above
  // the fixed Pay bar — ScrollView never auto-scrolls a focused input into
  // view, so the keyboard can hide it entirely. Scroll to end on focus
  // brings it above the keyboard, same fix applied to Exam PIN/TV/Airtime.
  const scrollRef = useRef<ScrollView>(null);

  // Pre-payment meter verification (see ElectricityPayScreen weakness raised
  // by the owner: nothing today confirms a meter number is real before the
  // PIN is charged). Debounced auto-check against VTUnaija's own verify
  // endpoint. Saved server-verified accounts render immediately while a
  // silent refresh runs; new or changed meters must verify before payment.
  const [verifyState, setVerifyState] = useState<VerifyState>('idle');
  const [verifiedName, setVerifiedName] = useState<string | null>(null);
  const [verifiedAddress, setVerifiedAddress] = useState<string | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [savedAccounts, setSavedAccounts] = useState<SavedBillingAccount[]>([]);
  // True until the first saved-accounts fetch settles. Without this, the
  // screen has no way to tell "still checking" apart from "genuinely none
  // saved" — savedAccounts starts as [], so the blank manual-entry box
  // rendered first on every visit, then got replaced by the saved meter once
  // the network call returned, even for an account saved the day before.
  const [savedAccountsLoading, setSavedAccountsLoading] = useState(true);
  const [cachedPreviewName, setCachedPreviewName] = useState<string | null>(null);
  const [showManualInput, setShowManualInput] = useState(false);
  // Admin-set convenience fee (see vtuService.getElectricityFee) — added on
  // top of whatever the customer types below. Fetched fresh on every visit
  // so it can never go stale across a session; the server re-derives its own
  // authoritative fee at charge time regardless of what this shows.
  const [convenienceFee, setConvenienceFee] = useState(0);

  useFocusEffect(useCallback(() => {
    void vtuService.getElectricityFee().then(setConvenienceFee);
  }, []));

  const selectedSavedAccount = useMemo(
    () => savedAccounts.find((account) => account.account_number === meterNumber) ?? null,
    [meterNumber, savedAccounts],
  );

  const loadSavedAccounts = useCallback(async () => {
    try {
      const accounts = await vtuService.getSavedBillingAccounts('electricity', provider.id);
      setSavedAccounts(accounts);
    } finally {
      setSavedAccountsLoading(false);
    }
  }, [provider.id]);

  useFocusEffect(useCallback(() => {
    void loadSavedAccounts();
  }, [loadSavedAccounts]));

  const numericAmount = useMemo(() => parseInt(amount, 10), [amount]);
  const totalWithFee = numericAmount + convenienceFee;
  const isValidAmount = !isNaN(numericAmount) && numericAmount >= 500 && numericAmount <= 500000;
  const isValidMeter = meterNumber.trim().length >= 6;
  const canProceed =
    isValidMeter &&
    isValidAmount &&
    buyState !== 'processing' &&
    verifyState === 'verified';

  // Any edit to the meter number invalidates whatever was verified before —
  // never let a stale "✓ verified" carry over to a different meter number.
  // Also true across a DISCO switch on this same mounted screen: without
  // clearing savedAccounts/savedAccountsLoading here, a meter saved under
  // the PREVIOUS provider could flash on screen before the new provider's
  // list (or lack of one) has loaded.
  useEffect(() => {
    setMeterNumber('');
    setVerifyState('idle');
    setVerifiedName(null);
    setVerifiedAddress(null);
    setVerifyError(null);
    setCachedPreviewName(null);
    setSavedAccounts([]);
    setSavedAccountsLoading(true);
  }, [provider.id]);

  useEffect(() => {
    if (!isValidMeter) return;
    const handle = setTimeout(async () => {
      const usingCachedVerification = cachedPreviewName !== null;
      if (!usingCachedVerification) setVerifyState('checking');
      const res = await vtuService.verifyElectricityMeter(provider.id, meterNumber.trim());
      setVerifyState((current) => {
        // A newer keystroke may have already reset this back to 'idle' while
        // the request was in flight — don't resurrect a stale result.
        if (usingCachedVerification) return res.ok ? 'verified' : current;
        if (current !== 'checking') return current;
        return res.ok ? 'verified' : 'failed';
      });
      if (res.ok) {
        setVerifiedName(res.customerName);
        setVerifiedAddress(res.customerAddress);
        setShowManualInput(false);
        void loadSavedAccounts();
      } else {
        setVerifyError(res.error || 'Could not verify this meter number.');
      }
    }, 700);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meterNumber, isValidMeter, provider.id, loadSavedAccounts, cachedPreviewName]);

  // The single next thing the user must do before Pay can proceed — so the
  // greyed button is never a silent dead end. null once everything's ready.
  const payHint = useMemo(() => {
    if (buyState === 'processing') return null;
    if (!isValidMeter) return 'Enter your meter number';
    if (numericAmount > 500000) return 'Maximum amount is ₦500,000';
    if (!isValidAmount) return 'Enter an amount of at least ₦500';
    if (verifyState === 'checking') return 'Verifying meter number…';
    if (verifyState === 'failed') return 'Could not verify meter number';
    return null;
  }, [buyState, isValidMeter, numericAmount, isValidAmount, verifyState]);

  const handleMeterChange = useCallback((text: string) => {
    setMeterNumber(text.replace(/[^0-9]/g, '').slice(0, 13));
    setCachedPreviewName(null);
    setVerifyState('idle');
    setVerifiedName(null);
    setVerifiedAddress(null);
    setVerifyError(null);
  }, []);

  const handleSavedAccountSelect = useCallback((account: SavedBillingAccount) => {
    setShowManualInput(false);
    handleMeterChange(account.account_number);
    setCachedPreviewName(account.customer_name);
    setVerifiedName(account.customer_name);
    setVerifiedAddress(account.customer_address);
    setVerifyState('verified');
  }, [handleMeterChange]);

  const handleUseAnotherMeter = useCallback(() => {
    setShowManualInput(true);
    handleMeterChange('');
  }, [handleMeterChange]);

  const handleRemoveSavedAccount = useCallback((account: SavedBillingAccount) => {
    Alert.alert(
      'Remove saved meter?',
      `Remove ${account.account_number} from your saved ${provider.name} meters?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            const removed = await vtuService.deleteSavedBillingAccount(account.id);
            if (!removed) {
              Alert.alert('Could not remove meter', 'Please try again.');
              return;
            }
            setSavedAccounts((current) => current.filter((item) => item.id !== account.id));
            if (account.account_number === meterNumber) {
              setShowManualInput(true);
              handleMeterChange('');
            }
          },
        },
      ],
    );
  }, [handleMeterChange, meterNumber, provider.name]);

  const handleQuickAmount = useCallback((quickAmount: number) => {
    setAmount(quickAmount.toString());
    Keyboard.dismiss();
  }, []);

  const handleAmountChange = useCallback((text: string) => {
    setAmount(text.replace(/[^0-9]/g, '').slice(0, 6));
  }, []);

  const handlePay = useCallback(async () => {
    if (!canProceed) return;
    setBuyState('processing');
    const subtitle = convenienceFee > 0
      ? `${provider.name} · Meter ${meterNumber.trim()}${verifiedName ? ` · ${verifiedName}` : ''} · includes ${formatNaira(convenienceFee)} fee`
      : verifiedName
        ? `${provider.name} · Meter ${meterNumber.trim()} · ${verifiedName}`
        : `${provider.name} · Meter ${meterNumber.trim()}`;
    const authResult = await authorize({ title: 'Confirm Electricity Payment', amount: totalWithFee, subtitle });
    if (!authResult) {
      setBuyState('idle');
      return;
    }

    setErrorMessage('');
    // Go STRAIGHT to the result screen — it runs the purchase itself and shows
    // Processing -> Successful (with the meter token, units, and Download/Share
    // Receipt). No spinner on the Pay button first. request.amount stays the
    // customer's entered top-up amount (what the meter is credited) — the
    // server adds its own authoritative fee on top of that for the wallet
    // debit, so `amount` here (header/receipt display) mirrors that total.
    navigation.navigate('TransactionStatus', {
      title: 'Electricity',
      amount: totalWithFee,
      recipient: meterNumber.trim(),
      paymentMethod: 'Balance',
      electricity: {
        providerName: provider.name,
        meterType: provider.type,
        customerName: verifiedName ?? undefined,
        customerAddress: verifiedAddress ?? undefined,
      },
      request: {
        kind: 'electricity',
        providerId: provider.id,
        meterNumber: meterNumber.trim(),
        amount: numericAmount,
        type: provider.type,
        authToken: authResult.token,
        customerName: verifiedName ?? undefined,
        customerAddress: verifiedAddress ?? undefined,
        quotedTotalNaira: totalWithFee,
      },
    });
  }, [canProceed, provider, meterNumber, numericAmount, totalWithFee, convenienceFee, navigation, authorize, verifiedName, verifiedAddress]);

  const buildReceiptHtml = useCallback(
    () =>
      buildElectricityReceiptHtml({
        providerName: provider.name,
        meterType: provider.type,
        meterNumber,
        amount: totalWithFee,
        feeAmount: convenienceFee,
        token: resultToken,
        units: resultUnits,
        orderId: resultOrderId,
      }),
    [provider, meterNumber, totalWithFee, convenienceFee, resultToken, resultUnits, resultOrderId],
  );

  const handleDownloadReceipt = useCallback(async () => {
    setGeneratingPdf(true);
    try {
      await downloadPdf(buildReceiptHtml(), `Electricity_Receipt_${meterNumber}`);
      Alert.alert(
        Platform.OS === 'android' ? 'Downloaded' : 'Saved',
        Platform.OS === 'android' ? 'Receipt saved to the folder you selected.' : 'Choose "Save to Files" to store it on your device.',
      );
    } catch (e) {
      Alert.alert('Error', safeErrorMessage(e, 'Could not save the receipt. Please try again.'));
    } finally {
      setGeneratingPdf(false);
    }
  }, [buildReceiptHtml, meterNumber]);

  const handleShareReceipt = useCallback(async () => {
    setGeneratingPdf(true);
    try {
      await sharePdf(buildReceiptHtml(), 'Share your electricity receipt');
    } catch (e) {
      Alert.alert('Error', safeErrorMessage(e, 'Could not generate the receipt. Please try again.'));
    } finally {
      setGeneratingPdf(false);
    }
  }, [buildReceiptHtml]);

  if (buyState === 'success') {
    return (
      <SafeAreaView style={styles.container}>
        <ScrollView contentContainerStyle={styles.resultContainer} showsVerticalScrollIndicator={false}>
          <View style={styles.successIcon}>
            <Text style={styles.successIconText}>{'✓'}</Text>
          </View>
          <Text style={styles.resultTitle}>
            {resultPending ? 'Order Processing' : 'Payment Successful'}
          </Text>
          {resultPending && (
            <Text style={styles.resultDetail}>You'll be notified once it completes.</Text>
          )}
          <Text style={styles.resultDetail}>{provider.name}</Text>
          <Text style={styles.resultDetail}>Meter: {meterNumber}</Text>
          <Text style={styles.resultAmount}>{formatNaira(totalWithFee)}</Text>
          {convenienceFee > 0 && (
            <Text style={styles.resultDetail}>{formatNaira(numericAmount)} top-up + {formatNaira(convenienceFee)} fee</Text>
          )}
          {resultToken && (
            <View style={styles.tokenContainer}>
              <Text style={styles.tokenLabel}>Your Token</Text>
              <Text style={styles.tokenValue}>{resultToken}</Text>
              {resultUnits && <Text style={styles.resultDetail}>{resultUnits}</Text>}
            </View>
          )}

          <TouchableOpacity
            style={[styles.primaryButton, generatingPdf && styles.primaryButtonDisabled]}
            onPress={handleDownloadReceipt}
            disabled={generatingPdf}
          >
            {generatingPdf ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={styles.primaryButtonText}>Download Receipt (PDF)</Text>
            )}
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.secondaryButton, generatingPdf && styles.primaryButtonDisabled]}
            onPress={handleShareReceipt}
            disabled={generatingPdf}
          >
            <Text style={styles.secondaryButtonText}>Share Receipt</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.doneButton} onPress={() => { Keyboard.dismiss(); navigation.goBack(); }}>
            <Text style={styles.doneButtonText}>Done</Text>
          </TouchableOpacity>
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          ref={scrollRef}
          style={styles.scrollView}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <TouchableOpacity
            style={styles.backButton}
            activeOpacity={0.6}
            onPress={() => { Keyboard.dismiss(); navigation.goBack(); }}
          >
            <Text style={styles.backText}>{'<'}</Text>
          </TouchableOpacity>

          <View style={styles.providerHeader}>
            <ProviderLogo source={ELECTRICITY_LOGOS[provider.id]} fallbackLabel={provider.name} size={48} />
            <View style={styles.providerHeaderText}>
              <Text style={styles.providerHeaderName}>{provider.name}</Text>
              <Text style={styles.providerType}>{provider.type}</Text>
            </View>
          </View>

          <View style={styles.section}>
            <Text style={styles.label}>Meter Number</Text>
            <View style={styles.arrearsNotice}>
              <Ionicons name="information-circle-outline" size={22} color={theme.brand} />
              <Text style={styles.arrearsNoticeText}>
                Your electricity provider may apply outstanding debt or a minimum payment requirement. The final amount and units are determined by your DISCO.
              </Text>
            </View>
            {savedAccountsLoading ? (
              // Distinguishes "still checking" from "genuinely none saved" so
              // the blank manual-entry box below never flashes on screen
              // before a saved meter that is about to appear anyway.
              <View style={styles.savedAccountsLoadingRow}>
                <ActivityIndicator size="small" color={theme.inkMuted} />
                <Text style={styles.savedAccountsLoadingText}>Checking for saved meters…</Text>
              </View>
            ) : savedAccounts.length > 0 ? (
              <View style={styles.savedAccounts}>
                <Text style={styles.savedLabel}>Saved meters</Text>
                {savedAccounts.map((account) => (
                  <View
                    key={account.id}
                    style={[
                      styles.savedAccount,
                      selectedSavedAccount?.id === account.id && styles.savedAccountSelected,
                    ]}
                  >
                    <TouchableOpacity style={styles.savedAccountSelect} onPress={() => handleSavedAccountSelect(account)} activeOpacity={0.75}>
                      <View
                        style={[
                          styles.savedAccountIcon,
                          selectedSavedAccount?.id === account.id && styles.savedAccountIconSelected,
                        ]}
                      >
                        <Ionicons
                          name={selectedSavedAccount?.id === account.id ? 'checkmark' : 'flash-outline'}
                          size={20}
                          color={selectedSavedAccount?.id === account.id ? '#FFFFFF' : theme.brand}
                        />
                      </View>
                      <View style={styles.savedAccountCopy}>
                        <Text style={styles.savedNumber}>{account.account_number}</Text>
                        <Text style={styles.savedName} numberOfLines={1}>{account.customer_name}</Text>
                      </View>
                      {selectedSavedAccount?.id === account.id ? (
                        <Text style={styles.selectedBadge}>Selected</Text>
                      ) : null}
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.removeSavedButton} onPress={() => handleRemoveSavedAccount(account)} activeOpacity={0.75}>
                      <Ionicons name="trash-outline" size={18} color={theme.down} />
                      <Text style={styles.removeSavedText}>Remove</Text>
                    </TouchableOpacity>
                  </View>
                ))}

                {!showManualInput ? (
                  <TouchableOpacity
                    style={styles.useAnotherButton}
                    onPress={handleUseAnotherMeter}
                    activeOpacity={0.75}
                  >
                    <Ionicons name="add" size={22} color={theme.brand} />
                    <Text style={styles.useAnotherText}>Use another meter</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            ) : null}
            {!savedAccountsLoading && (savedAccounts.length === 0 || showManualInput) ? (
              <TextInput
                style={styles.input}
                value={meterNumber}
                onChangeText={handleMeterChange}
                placeholder="Enter meter number"
                placeholderTextColor={theme.inkMuted}
                keyboardType="number-pad"
                maxLength={13}
              />
            ) : null}
            {verifyState === 'checking' && (
              <View style={styles.verifyRow}>
                <ActivityIndicator size="small" color={theme.inkMuted} />
                <Text style={styles.verifyCheckingText}>Verifying meter number…</Text>
              </View>
            )}
            {verifyState === 'checking' && cachedPreviewName ? (
              <Text style={styles.cachedPreview}>Previously verified: {cachedPreviewName}</Text>
            ) : null}
            {verifyState === 'verified' && verifiedName && (
              <View style={styles.verifiedCard}>
                <View style={styles.verifiedHeading}>
                  <View style={styles.verifiedIcon}>
                    <Ionicons name="checkmark" size={16} color="#FFFFFF" />
                  </View>
                  <Text style={styles.verifiedTitle}>Meter verified</Text>
                </View>
                <Text style={styles.verifiedName}>{verifiedName}</Text>
                {verifiedAddress ? (
                  <View style={styles.verifiedAddressRow}>
                    <Text style={styles.verifiedAddressLabel}>Service address</Text>
                    <Text style={styles.verifiedAddressValue}>{verifiedAddress}</Text>
                  </View>
                ) : null}
              </View>
            )}
            {verifyState === 'failed' && (
              <View style={styles.verifyFailedBlock}>
                <Text style={styles.verifyFailedText}>
                  {verifyError || 'Could not verify this meter number.'}
                </Text>
              </View>
            )}
          </View>

          <View style={styles.section}>
            <Text style={styles.label}>Amount</Text>
            <View style={styles.quickAmountsContainer}>
              {QUICK_AMOUNTS.map((quickAmount) => {
                const isSelected = numericAmount === quickAmount;
                return (
                  <TouchableOpacity
                    key={quickAmount}
                    style={[
                      styles.quickAmountButton,
                      isSelected && styles.quickAmountButtonSelected,
                    ]}
                    onPress={() => handleQuickAmount(quickAmount)}
                    disabled={buyState === 'processing'}
                  >
                    <Text
                      style={[
                        styles.quickAmountText,
                        isSelected && styles.quickAmountTextSelected,
                      ]}
                    >
                      {formatNaira(quickAmount)}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            <View style={styles.customAmountContainer}>
              <Text style={styles.currencySymbol}>{formatNaira(0).charAt(0)}</Text>
              <TextInput
                style={styles.amountInput}
                placeholder="Custom amount"
                placeholderTextColor={theme.inkMuted}
                value={amount}
                onChangeText={handleAmountChange}
                onFocus={() => scrollRef.current?.scrollToEnd({ animated: true })}
                keyboardType="numeric"
                maxLength={6}
              />
            </View>
            {numericAmount > 0 && !isValidAmount && (
              <Text style={styles.amountError}>
                {numericAmount < 500
                  ? 'Minimum amount is ₦500'
                  : 'Maximum amount is ₦500,000'}
              </Text>
            )}
            {isValidAmount && convenienceFee > 0 && (
              <Text style={styles.feeNoticeText}>
                + {formatNaira(convenienceFee)} convenience fee — you'll pay {formatNaira(totalWithFee)}, the meter is credited {formatNaira(numericAmount)}
              </Text>
            )}
          </View>

          {errorMessage ? (
            <View style={styles.errorContainer}>
              <Text style={styles.errorText}>{errorMessage}</Text>
            </View>
          ) : null}
        </ScrollView>

        <View style={[styles.bottomBar, { paddingBottom: insets.bottom + Spacing.L }]}>
          {numericAmount > 0 && (
            <View style={styles.summary}>
              <Text style={styles.summaryText} numberOfLines={1}>
                {provider.name}{' · '}Meter {meterNumber || '---'}
              </Text>
              <Text style={styles.summaryAmount}>{formatNaira(totalWithFee)}</Text>
            </View>
          )}
          {payHint && (
            <View style={styles.payHintRow}>
              <Text style={styles.payHintText}>{payHint}</Text>
            </View>
          )}
          <TouchableOpacity
            style={[
              styles.primaryButton,
              (!canProceed || buyState === ('processing' as BuyState)) && styles.primaryButtonDisabled,
            ]}
            onPress={handlePay}
            disabled={!canProceed}
          >
            {buyState === 'processing' ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={styles.primaryButtonText}>
                Pay{numericAmount > 0 ? ` ${formatNaira(totalWithFee)}` : ''}
              </Text>
            )}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
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
    // See ExamPinsScreen.tsx's identical comment — 120 only fit the Pay
    // button alone; the hint line above it (e.g. meter-verify status) could
    // push it taller than that, hiding content behind it with no way to
    // scroll past.
    paddingBottom: 180,
  },
  backButton: {
    width: 48,
    height: 48,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: Spacing.M,
  },
  backText: { fontSize: 28, fontWeight: '600', color: theme.ink },
  providerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: Spacing.XL,
  },
  providerHeaderText: { marginLeft: Spacing.M, flex: 1 },
  providerHeaderName: { ...Typography.SCREEN_TITLE, color: theme.ink },
  providerType: { ...Typography.CAPTION, textTransform: 'capitalize', color: theme.inkMuted },
  section: { marginBottom: Spacing.XL },
  label: { ...Typography.SECTION_HEADING, color: theme.ink, marginBottom: Spacing.M },
  input: {
    height: Spacing.INPUT_HEIGHT,
    borderWidth: Spacing.INPUT_BORDER_WIDTH,
    borderColor: theme.border,
    borderRadius: Spacing.BUTTON_RADIUS,
    paddingHorizontal: Spacing.L,
    ...Typography.BODY,
    color: theme.ink,
  },
  quickAmountsContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.M,
    marginBottom: Spacing.M,
  },
  quickAmountButton: {
    paddingHorizontal: Spacing.L,
    height: Spacing.CHIP_HEIGHT,
    borderRadius: Spacing.CHIP_HEIGHT / 2,
    borderWidth: 1,
    borderColor: theme.border,
    justifyContent: 'center',
    alignItems: 'center',
  },
  quickAmountButtonSelected: { borderColor: theme.brand, backgroundColor: theme.brand },
  quickAmountText: { ...Typography.BODY, fontSize: 13, color: theme.ink },
  quickAmountTextSelected: { color: '#FFFFFF', fontFamily: 'Helvetica-Bold' },
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
  feeNoticeText: { ...Typography.CAPTION, color: theme.inkMuted, marginTop: Spacing.S },
  verifyRow: { flexDirection: 'row', alignItems: 'center', marginTop: Spacing.S },
  arrearsNotice: { flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.M, backgroundColor: theme.brandSoft, borderWidth: 1, borderColor: theme.brandSoft, borderRadius: Spacing.BUTTON_RADIUS, padding: Spacing.M, marginBottom: Spacing.M },
  arrearsNoticeText: { ...Typography.CAPTION, flex: 1, color: theme.ink, lineHeight: 19 },
  savedAccounts: { marginBottom: Spacing.M, gap: Spacing.M },
  savedLabel: { ...Typography.CAPTION, color: theme.inkMuted, marginBottom: Spacing.S },
  savedAccountsLoadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.S,
    paddingVertical: Spacing.M,
    marginBottom: Spacing.M,
  },
  savedAccountsLoadingText: { ...Typography.CAPTION, color: theme.inkMuted },
  savedAccount: { minHeight: 72, flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: theme.border, borderRadius: Spacing.BUTTON_RADIUS, backgroundColor: theme.surface },
  savedAccountSelected: { borderColor: theme.brand, backgroundColor: theme.brandSoft },
  savedAccountSelect: { flex: 1, minHeight: 70, paddingHorizontal: Spacing.M, paddingVertical: Spacing.S, flexDirection: 'row', alignItems: 'center', gap: Spacing.M },
  savedAccountIcon: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.brandSoft },
  savedAccountIconSelected: { backgroundColor: theme.brand },
  savedAccountCopy: { flex: 1 },
  selectedBadge: { ...Typography.CAPTION, color: theme.brand, fontWeight: '700', backgroundColor: theme.brandSoft, borderRadius: 12, paddingHorizontal: Spacing.M, paddingVertical: Spacing.S },
  removeSavedButton: { minWidth: 76, minHeight: 70, justifyContent: 'center', alignItems: 'center', gap: Spacing.XS, paddingHorizontal: Spacing.S },
  removeSavedText: { ...Typography.CAPTION, color: theme.down, fontWeight: '600' },
  savedNumber: { ...Typography.BODY, color: theme.ink, fontWeight: '600' },
  savedName: { ...Typography.CAPTION, color: theme.inkMuted, marginTop: 2 },
  useAnotherButton: { minHeight: Spacing.TOUCH_TARGET_MIN, borderWidth: 1, borderStyle: 'dashed', borderColor: theme.brand, borderRadius: Spacing.BUTTON_RADIUS, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: Spacing.M },
  useAnotherText: { ...Typography.BODY, color: theme.brand, fontWeight: '700' },
  cachedPreview: { ...Typography.CAPTION, color: theme.inkMuted, marginTop: Spacing.S },
  verifyCheckingText: { ...Typography.CAPTION, color: theme.inkMuted, marginLeft: Spacing.S },
  verifiedCard: { marginTop: Spacing.M, padding: Spacing.L, borderRadius: Spacing.CARD_RADIUS, backgroundColor: theme.brandSoft },
  verifiedHeading: { flexDirection: 'row', alignItems: 'center', gap: Spacing.M },
  verifiedIcon: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.brand },
  verifiedTitle: { ...Typography.BODY, color: theme.brand, fontWeight: '700' },
  verifiedName: { ...Typography.BODY, color: theme.ink, marginTop: Spacing.M },
  verifiedAddressRow: { marginTop: Spacing.L, paddingTop: Spacing.M, borderTopWidth: 1, borderTopColor: theme.hairlineSoft, gap: Spacing.S },
  verifiedAddressLabel: { ...Typography.CAPTION, color: theme.inkMuted },
  verifiedAddressValue: { ...Typography.BODY, color: theme.ink, fontWeight: '600' },
  verifyFailedBlock: { marginTop: Spacing.S },
  verifyFailedText: { ...Typography.CAPTION, color: theme.down },
  verifyProceedLink: { ...Typography.CAPTION, color: '#7C3AED', marginTop: Spacing.S, textDecorationLine: 'underline' },
  errorContainer: { marginTop: Spacing.M },
  errorText: { ...Typography.ERROR },
  bottomBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: theme.surface,
    borderTopWidth: 1,
    borderTopColor: theme.border,
    paddingHorizontal: Spacing.SCREEN_PADDING,
    paddingTop: Spacing.L,
  },
  summary: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: Spacing.L,
  },
  summaryText: { ...Typography.BODY, color: theme.ink, flex: 1 },
  summaryAmount: { ...Typography.AMOUNT_SMALL, color: theme.ink },
  payHintRow: { marginBottom: Spacing.M, alignItems: 'center' },
  payHintText: { ...Typography.CAPTION, color: theme.inkMuted, textAlign: 'center' },
  primaryButton: {
    width: '100%',
    height: Spacing.BUTTON_HEIGHT_PRIMARY,
    backgroundColor: theme.brand,
    borderRadius: Spacing.BUTTON_RADIUS,
    justifyContent: 'center',
    alignItems: 'center',
  },
  primaryButtonDisabled: { opacity: 0.5 },
  primaryButtonText: { ...Typography.BUTTON_TEXT },
  secondaryButton: {
    width: '100%',
    height: Spacing.BUTTON_HEIGHT_PRIMARY,
    borderRadius: Spacing.BUTTON_RADIUS,
    borderWidth: 1,
    borderColor: theme.brand,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: Spacing.M,
  },
  secondaryButtonText: { ...Typography.BUTTON_TEXT, color: theme.brand },
  doneButton: {
    width: '100%',
    height: Spacing.BUTTON_HEIGHT_PRIMARY,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: Spacing.L,
  },
  doneButtonText: { ...Typography.BUTTON_TEXT, color: theme.inkMuted },
  resultContainer: { flexGrow: 1, justifyContent: 'center', alignItems: 'center', padding: Spacing.SCREEN_PADDING },
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
  resultDetail: { ...Typography.BODY, color: theme.inkMuted, marginBottom: Spacing.S },
  resultAmount: { ...Typography.AMOUNT_LARGE, color: theme.brand, marginTop: Spacing.L, marginBottom: Spacing.L },
  tokenContainer: {
    backgroundColor: theme.surfaceRaised,
    borderRadius: Spacing.CARD_RADIUS,
    padding: Spacing.CARD_PADDING,
    width: '100%',
    alignItems: 'center',
    marginBottom: Spacing.XL,
  },
  tokenLabel: { ...Typography.CAPTION, color: theme.inkMuted, marginBottom: Spacing.S },
  tokenValue: { ...Typography.CODE, color: theme.brand, letterSpacing: 2 },
  });
}
