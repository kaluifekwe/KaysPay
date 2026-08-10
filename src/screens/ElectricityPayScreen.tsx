import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
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
import { Colors } from '../constants/colors';
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
  // endpoint; `proceedWithoutVerify` lets the user explicitly continue if
  // verification fails or is unavailable, rather than hard-blocking a
  // legitimate payment on a flaky check.
  const [verifyState, setVerifyState] = useState<VerifyState>('idle');
  const [verifiedName, setVerifiedName] = useState<string | null>(null);
  const [verifiedAddress, setVerifiedAddress] = useState<string | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [proceedWithoutVerify, setProceedWithoutVerify] = useState(false);
  const [savedAccounts, setSavedAccounts] = useState<SavedBillingAccount[]>([]);
  const [cachedPreviewName, setCachedPreviewName] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    vtuService.getSavedBillingAccounts('electricity', provider.id).then((accounts) => {
      if (active) setSavedAccounts(accounts);
    });
    return () => { active = false; };
  }, [provider.id]);

  const numericAmount = useMemo(() => parseInt(amount, 10), [amount]);
  const isValidAmount = !isNaN(numericAmount) && numericAmount >= 500 && numericAmount <= 500000;
  const isValidMeter = meterNumber.trim().length >= 6;
  const canProceed =
    isValidMeter &&
    isValidAmount &&
    buyState !== 'processing' &&
    (verifyState === 'verified' || proceedWithoutVerify);

  // Any edit to the meter number invalidates whatever was verified before —
  // never let a stale "✓ verified" carry over to a different meter number.
  useEffect(() => {
    setVerifyState('idle');
    setVerifiedName(null);
    setVerifiedAddress(null);
    setVerifyError(null);
    setProceedWithoutVerify(false);
  }, [meterNumber, provider.id]);

  useEffect(() => {
    if (!isValidMeter) return;
    const handle = setTimeout(async () => {
      setVerifyState('checking');
      const res = await vtuService.verifyElectricityMeter(provider.id, meterNumber.trim());
      setVerifyState((current) => {
        // A newer keystroke may have already reset this back to 'idle' while
        // the request was in flight — don't resurrect a stale result.
        if (current !== 'checking') return current;
        return res.ok ? 'verified' : 'failed';
      });
      if (res.ok) {
        setVerifiedName(res.customerName);
        setVerifiedAddress(res.customerAddress);
      } else {
        setVerifyError(res.error || 'Could not verify this meter number.');
      }
    }, 700);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meterNumber, isValidMeter, provider.id]);

  const handleProceedAnyway = useCallback(() => {
    Alert.alert(
      'Continue without verification?',
      "We couldn't confirm this meter number belongs to a real account. Only continue if you're sure the meter number is correct — a wrong meter number means the units go to someone else's meter, not yours.",
      [
        { text: 'Cancel', style: 'cancel' },
        { text: "I'm sure, continue", onPress: () => setProceedWithoutVerify(true) },
      ],
    );
  }, []);

  // The single next thing the user must do before Pay can proceed — so the
  // greyed button is never a silent dead end. null once everything's ready.
  const payHint = useMemo(() => {
    if (buyState === 'processing') return null;
    if (!isValidMeter) return 'Enter your meter number';
    if (numericAmount > 500000) return 'Maximum amount is ₦500,000';
    if (!isValidAmount) return 'Enter an amount of at least ₦500';
    if (verifyState === 'checking') return 'Verifying meter number…';
    if (verifyState === 'failed' && !proceedWithoutVerify) return 'Could not verify meter number';
    return null;
  }, [buyState, isValidMeter, numericAmount, isValidAmount, verifyState, proceedWithoutVerify]);

  const handleMeterChange = useCallback((text: string) => {
    setMeterNumber(text.replace(/[^0-9]/g, '').slice(0, 13));
    setCachedPreviewName(null);
  }, []);

  const handleSavedAccountSelect = useCallback((account: SavedBillingAccount) => {
    handleMeterChange(account.account_number);
    setCachedPreviewName(account.customer_name);
  }, [handleMeterChange]);

  const handleQuickAmount = useCallback((quickAmount: number) => {
    setAmount(quickAmount.toString());
    Keyboard.dismiss();
  }, []);

  const handleAmountChange = useCallback((text: string) => {
    setAmount(text.replace(/[^0-9]/g, '').slice(0, 6));
  }, []);

  const handlePay = useCallback(async () => {
    if (!canProceed) return;

    // Subtitle shows exactly what's being confirmed — disco, meter, and (if
    // verified) the real customer name — so the PIN prompt is never a bare
    // "enter your PIN" with no context to check against.
    const subtitle = verifiedName
      ? `${provider.name} · Meter ${meterNumber.trim()} · ${verifiedName}`
      : `${provider.name} · Meter ${meterNumber.trim()}`;
    const authResult = await authorize({ title: 'Confirm Electricity Payment', amount: numericAmount, subtitle });
    if (!authResult) return;

    setErrorMessage('');
    // Go STRAIGHT to the result screen — it runs the purchase itself and shows
    // Processing -> Successful (with the meter token, units, and Download/Share
    // Receipt). No spinner on the Pay button first.
    navigation.navigate('TransactionStatus', {
      title: 'Electricity',
      amount: numericAmount,
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
      },
    });
  }, [canProceed, provider, meterNumber, numericAmount, navigation, authorize, verifiedName, verifiedAddress]);

  const buildReceiptHtml = useCallback(
    () =>
      buildElectricityReceiptHtml({
        providerName: provider.name,
        meterType: provider.type,
        meterNumber,
        amount: numericAmount,
        token: resultToken,
        units: resultUnits,
        orderId: resultOrderId,
      }),
    [provider, meterNumber, numericAmount, resultToken, resultUnits, resultOrderId],
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
      Alert.alert('Error', (e as Error).message || 'Could not save the receipt. Please try again.');
    } finally {
      setGeneratingPdf(false);
    }
  }, [buildReceiptHtml, meterNumber]);

  const handleShareReceipt = useCallback(async () => {
    setGeneratingPdf(true);
    try {
      await sharePdf(buildReceiptHtml(), 'Share your electricity receipt');
    } catch (e) {
      Alert.alert('Error', (e as Error).message || 'Could not generate the receipt. Please try again.');
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
          <Text style={styles.resultAmount}>{formatNaira(numericAmount)}</Text>
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
              <ActivityIndicator color={Colors.WHITE} />
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

          <TouchableOpacity style={styles.doneButton} onPress={() => navigation.goBack()}>
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
            onPress={() => navigation.goBack()}
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
              <Text style={styles.arrearsNoticeText}>
                Your electricity provider may apply outstanding debt or a minimum payment requirement. The final amount and units are determined by your DISCO.
              </Text>
            </View>
            {savedAccounts.length > 0 ? (
              <View style={styles.savedAccounts}>
                <Text style={styles.savedLabel}>Previously used meters</Text>
                {savedAccounts.map((account) => (
                  <TouchableOpacity
                    key={account.id}
                    style={styles.savedAccount}
                    onPress={() => handleSavedAccountSelect(account)}
                    activeOpacity={0.75}
                  >
                    <Text style={styles.savedNumber}>{account.account_number}</Text>
                    <Text style={styles.savedName} numberOfLines={1}>{account.customer_name}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            ) : null}
            <TextInput
              style={styles.input}
              value={meterNumber}
              onChangeText={handleMeterChange}
              placeholder="Enter meter number"
              placeholderTextColor={Colors.GRAY}
              keyboardType="number-pad"
              maxLength={13}
            />
            {verifyState === 'checking' && (
              <View style={styles.verifyRow}>
                <ActivityIndicator size="small" color={Colors.GRAY} />
                <Text style={styles.verifyCheckingText}>Verifying meter number…</Text>
              </View>
            )}
            {verifyState === 'checking' && cachedPreviewName ? (
              <Text style={styles.cachedPreview}>Previously verified: {cachedPreviewName}</Text>
            ) : null}
            {verifyState === 'verified' && verifiedName && (
              <View style={styles.verifyRow}>
                <Text style={styles.verifySuccessText}>✓ {verifiedName}</Text>
              </View>
            )}
            {verifyState === 'failed' && (
              <View style={styles.verifyFailedBlock}>
                <Text style={styles.verifyFailedText}>
                  {proceedWithoutVerify
                    ? "Proceeding without verification — double-check this meter number."
                    : (verifyError || 'Could not verify this meter number.')}
                </Text>
                {!proceedWithoutVerify && (
                  <TouchableOpacity onPress={handleProceedAnyway}>
                    <Text style={styles.verifyProceedLink}>I'm sure this is correct, continue anyway</Text>
                  </TouchableOpacity>
                )}
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
                placeholderTextColor={Colors.GRAY}
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
              <Text style={styles.summaryAmount}>{formatNaira(numericAmount)}</Text>
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
              <ActivityIndicator color={Colors.WHITE} />
            ) : (
              <Text style={styles.primaryButtonText}>
                Pay{numericAmount > 0 ? ` ${formatNaira(numericAmount)}` : ''}
              </Text>
            )}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.WHITE },
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
  backText: { fontSize: 28, fontWeight: '600', color: Colors.DARK },
  providerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: Spacing.XL,
  },
  providerHeaderText: { marginLeft: Spacing.M, flex: 1 },
  providerHeaderName: { ...Typography.SCREEN_TITLE },
  providerType: { ...Typography.CAPTION, textTransform: 'capitalize', color: Colors.GRAY },
  section: { marginBottom: Spacing.XL },
  label: { ...Typography.SECTION_HEADING, marginBottom: Spacing.M },
  input: {
    height: Spacing.INPUT_HEIGHT,
    borderWidth: Spacing.INPUT_BORDER_WIDTH,
    borderColor: Colors.BORDER,
    borderRadius: Spacing.BUTTON_RADIUS,
    paddingHorizontal: Spacing.L,
    ...Typography.BODY,
    color: Colors.DARK,
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
    borderColor: Colors.BORDER,
    justifyContent: 'center',
    alignItems: 'center',
  },
  quickAmountButtonSelected: { borderColor: Colors.GREEN, backgroundColor: Colors.GREEN },
  quickAmountText: { ...Typography.BODY, fontSize: 13, color: Colors.DARK },
  quickAmountTextSelected: { color: Colors.WHITE, fontFamily: 'Helvetica-Bold' },
  customAmountContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    height: Spacing.INPUT_HEIGHT,
    borderWidth: Spacing.INPUT_BORDER_WIDTH,
    borderColor: Colors.BORDER,
    borderRadius: Spacing.BUTTON_RADIUS,
    paddingHorizontal: Spacing.L,
  },
  currencySymbol: { ...Typography.BODY, fontWeight: '600', color: Colors.DARK, marginRight: Spacing.S },
  amountInput: { flex: 1, ...Typography.BODY, color: Colors.DARK },
  amountError: { ...Typography.ERROR, marginTop: Spacing.S },
  verifyRow: { flexDirection: 'row', alignItems: 'center', marginTop: Spacing.S },
  arrearsNotice: { backgroundColor: Colors.GREEN_LIGHT, borderRadius: Spacing.BUTTON_RADIUS, padding: Spacing.M, marginBottom: Spacing.M },
  arrearsNoticeText: { ...Typography.CAPTION, color: Colors.DARK, lineHeight: 19 },
  savedAccounts: { marginBottom: Spacing.M },
  savedLabel: { ...Typography.CAPTION, color: Colors.GRAY, marginBottom: Spacing.S },
  savedAccount: { minHeight: 52, borderWidth: 1, borderColor: Colors.BORDER, borderRadius: Spacing.BUTTON_RADIUS, paddingHorizontal: Spacing.M, paddingVertical: Spacing.S, marginBottom: Spacing.S, justifyContent: 'center' },
  savedNumber: { ...Typography.BODY, color: Colors.DARK, fontWeight: '600' },
  savedName: { ...Typography.CAPTION, color: Colors.GRAY, marginTop: 2 },
  cachedPreview: { ...Typography.CAPTION, color: Colors.GRAY, marginTop: Spacing.S },
  verifyCheckingText: { ...Typography.CAPTION, color: Colors.GRAY, marginLeft: Spacing.S },
  verifySuccessText: { ...Typography.CAPTION, color: Colors.GREEN, fontFamily: 'Helvetica-Bold' },
  verifyFailedBlock: { marginTop: Spacing.S },
  verifyFailedText: { ...Typography.CAPTION, color: Colors.ERROR },
  verifyProceedLink: { ...Typography.CAPTION, color: Colors.PURPLE, marginTop: Spacing.S, textDecorationLine: 'underline' },
  errorContainer: { marginTop: Spacing.M },
  errorText: { ...Typography.ERROR },
  bottomBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: Colors.WHITE,
    borderTopWidth: 1,
    borderTopColor: Colors.BORDER,
    paddingHorizontal: Spacing.SCREEN_PADDING,
    paddingTop: Spacing.L,
  },
  summary: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: Spacing.L,
  },
  summaryText: { ...Typography.BODY, flex: 1 },
  summaryAmount: { ...Typography.AMOUNT_SMALL },
  payHintRow: { marginBottom: Spacing.M, alignItems: 'center' },
  payHintText: { ...Typography.CAPTION, color: Colors.GRAY, textAlign: 'center' },
  primaryButton: {
    width: '100%',
    height: Spacing.BUTTON_HEIGHT_PRIMARY,
    backgroundColor: Colors.GREEN,
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
    borderColor: Colors.GREEN,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: Spacing.M,
  },
  secondaryButtonText: { ...Typography.BUTTON_TEXT, color: Colors.GREEN },
  doneButton: {
    width: '100%',
    height: Spacing.BUTTON_HEIGHT_PRIMARY,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: Spacing.L,
  },
  doneButtonText: { ...Typography.BUTTON_TEXT, color: Colors.GRAY },
  resultContainer: { flexGrow: 1, justifyContent: 'center', alignItems: 'center', padding: Spacing.SCREEN_PADDING },
  successIcon: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: Colors.GREEN,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: Spacing.XL,
  },
  successIconText: { fontSize: 36, color: Colors.WHITE },
  resultTitle: { ...Typography.SCREEN_TITLE, marginBottom: Spacing.M },
  resultDetail: { ...Typography.BODY, color: Colors.GRAY, marginBottom: Spacing.S },
  resultAmount: { ...Typography.AMOUNT_LARGE, color: Colors.GREEN, marginTop: Spacing.L, marginBottom: Spacing.L },
  tokenContainer: {
    backgroundColor: Colors.LIGHT_GRAY,
    borderRadius: Spacing.CARD_RADIUS,
    padding: Spacing.CARD_PADDING,
    width: '100%',
    alignItems: 'center',
    marginBottom: Spacing.XL,
  },
  tokenLabel: { ...Typography.CAPTION, marginBottom: Spacing.S },
  tokenValue: { ...Typography.CODE, color: Colors.GREEN, letterSpacing: 2 },
});
