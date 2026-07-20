import React, { useState, useCallback, useMemo } from 'react';
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
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Colors } from '../constants/colors';
import { Typography } from '../constants/typography';
import { Spacing } from '../constants/spacing';
import { formatNaira } from '../utils/formatCurrency';
import { vtuService, type BettingProvider } from '../services/vtu.service';
import { useTransactionAuth } from '../components/TransactionAuthProvider';
import ProviderLogo from '../components/ProviderLogo';
import { BETTING_LOGOS } from '../utils/providerLogos';

type BuyState = 'idle' | 'processing' | 'success' | 'error';

const QUICK_AMOUNTS = [100, 500, 1000, 2000, 5000, 10000];

// Flat service fee added on top of the funding amount. MUST match the
// server's BETTING_SERVICE_FEE (vtu-catalog.ts) — the server independently
// enforces it; this is only for display + the auth prompt amount.
const BETTING_SERVICE_FEE = 30;

export default function BettingFundScreen(props: any) {
  const { navigation, route } = props;
  const { authorize } = useTransactionAuth();
  const insets = useSafeAreaInsets();
  const provider = route.params.provider as BettingProvider;

  const [customerId, setCustomerId] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [verified, setVerified] = useState(false);
  const [unverifiable, setUnverifiable] = useState(false);
  const [verifyError, setVerifyError] = useState('');
  const [amount, setAmount] = useState('');
  const [buyState, setBuyState] = useState<BuyState>('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const [resultPending, setResultPending] = useState(false);

  const numericAmount = useMemo(() => parseInt(amount, 10), [amount]);
  const isValidAmount = !isNaN(numericAmount) && numericAmount >= 100 && numericAmount <= 100000;
  const totalCharge = useMemo(
    () => (isValidAmount ? numericAmount + BETTING_SERVICE_FEE : 0),
    [numericAmount, isValidAmount],
  );
  const canProceed = verified && isValidAmount && buyState !== 'processing';

  const handleCustomerIdChange = useCallback((text: string) => {
    setCustomerId(text.replace(/[^0-9]/g, '').slice(0, 20));
    setVerified(false);
    setUnverifiable(false);
    setCustomerName('');
    setVerifyError('');
  }, []);

  const handleVerify = useCallback(async () => {
    if (customerId.trim().length < 4) return;

    setVerifying(true);
    setVerifyError('');

    const result = await vtuService.verifyBettingCustomer(provider.id, customerId.trim());

    setVerifying(false);

    if (!result.success) {
      setVerifyError(result.error || 'Could not verify this account');
      return;
    }

    if (result.unverifiable) {
      setCustomerName('');
      setUnverifiable(true);
      setVerified(true);
      return;
    }

    setCustomerName(result.customer_name || '');
    setUnverifiable(false);
    setVerified(true);
  }, [provider, customerId]);

  const handleQuickAmount = useCallback((quickAmount: number) => {
    setAmount(quickAmount.toString());
    Keyboard.dismiss();
  }, []);

  const handleAmountChange = useCallback((text: string) => {
    setAmount(text.replace(/[^0-9]/g, '').slice(0, 6));
  }, []);

  const handlePay = useCallback(async () => {
    if (!canProceed) return;

    const authResult = await authorize({ title: 'Confirm Betting Wallet Funding', amount: totalCharge });
    if (!authResult) return;

    setErrorMessage('');
    setBuyState('processing');

    try {
      const result = await vtuService.buyBetting(provider.id, customerId.trim(), numericAmount, authResult.token);

      if (result.success) {
        setResultPending(!!result.pending);
        setBuyState('success');
      } else {
        setErrorMessage(result.error || 'Betting wallet funding failed. Please try again.');
        setBuyState('error');
      }
    } catch {
      setErrorMessage('An unexpected error occurred. Please check your connection and try again.');
      setBuyState('error');
    }
  }, [canProceed, provider, customerId, numericAmount, totalCharge, authorize]);

  if (buyState === 'success') {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.resultContainer}>
          <View style={styles.successIcon}>
            <Text style={styles.successIconText}>{'✓'}</Text>
          </View>
          <Text style={styles.resultTitle}>
            {resultPending ? 'Funding Processing' : 'Funding Successful'}
          </Text>
          {resultPending && (
            <Text style={styles.resultDetail}>You'll be notified once it completes.</Text>
          )}
          <Text style={styles.resultDetail}>{provider.name}</Text>
          <Text style={styles.resultDetail}>{customerName || `Account ${customerId}`}</Text>
          <Text style={styles.resultAmount}>{formatNaira(numericAmount)}</Text>
          <TouchableOpacity style={styles.primaryButton} onPress={() => navigation.goBack()}>
            <Text style={styles.primaryButtonText}>Done</Text>
          </TouchableOpacity>
        </View>
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
            <ProviderLogo source={BETTING_LOGOS[provider.id]} fallbackLabel={provider.name} size={48} />
            <Text style={styles.providerHeaderName}>{provider.name}</Text>
          </View>

          <View style={styles.section}>
            <Text style={styles.label}>Account ID</Text>
            <TextInput
              style={styles.input}
              value={customerId}
              onChangeText={handleCustomerIdChange}
              placeholder="Enter your betting account ID"
              placeholderTextColor={Colors.GRAY}
              keyboardType="number-pad"
              maxLength={20}
            />

            {!verified && customerId.trim().length >= 4 && (
              <TouchableOpacity
                style={styles.verifyButton}
                onPress={handleVerify}
                disabled={verifying}
              >
                {verifying ? (
                  <ActivityIndicator size="small" color={Colors.WHITE} />
                ) : (
                  <Text style={styles.verifyButtonText}>Verify Account</Text>
                )}
              </TouchableOpacity>
            )}

            {verifyError ? <Text style={styles.amountError}>{verifyError}</Text> : null}

            {verified && customerName ? (
              <View style={styles.verifiedAccount}>
                <Text style={styles.verifiedIcon}>✓</Text>
                <View style={styles.verifiedInfo}>
                  <Text style={styles.verifiedName}>{customerName}</Text>
                  <Text style={styles.verifiedDetails}>
                    {provider.name} · {customerId}
                  </Text>
                </View>
              </View>
            ) : null}

            {verified && unverifiable ? (
              <View style={styles.unverifiableAccount}>
                <Text style={styles.unverifiableIcon}>{'!'}</Text>
                <View style={styles.verifiedInfo}>
                  <Text style={styles.unverifiableTitle}>Can't verify this account automatically</Text>
                  <Text style={styles.verifiedDetails}>
                    {provider.name} · Account {customerId} — please double-check this ID is correct before funding.
                  </Text>
                </View>
              </View>
            ) : null}
          </View>

          {verified && (
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
                  keyboardType="numeric"
                  maxLength={6}
                />
              </View>
              {numericAmount > 0 && !isValidAmount && (
                <Text style={styles.amountError}>
                  {numericAmount < 100
                    ? 'Minimum amount is ₦100'
                    : 'Maximum amount is ₦100,000'}
                </Text>
              )}
            </View>
          )}

          {errorMessage ? (
            <View style={styles.errorContainer}>
              <Text style={styles.errorText}>{errorMessage}</Text>
            </View>
          ) : null}
        </ScrollView>

        <View style={[styles.bottomBar, { paddingBottom: insets.bottom + Spacing.L }]}>
          {verified && isValidAmount && (
            <View style={styles.feeBreakdown}>
              <View style={styles.feeRow}>
                <Text style={styles.feeLabel}>Funding</Text>
                <Text style={styles.feeValue}>{formatNaira(numericAmount)}</Text>
              </View>
              <View style={styles.feeRow}>
                <Text style={styles.feeLabel}>Service fee</Text>
                <Text style={styles.feeValue}>{formatNaira(BETTING_SERVICE_FEE)}</Text>
              </View>
              <View style={[styles.feeRow, styles.feeTotalRow]}>
                <Text style={styles.feeTotalLabel} numberOfLines={1}>
                  {provider.name}{' · '}{customerName || `Account ${customerId}`}
                </Text>
                <Text style={styles.summaryAmount}>{formatNaira(totalCharge)}</Text>
              </View>
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
                Pay{totalCharge > 0 ? ` ${formatNaira(totalCharge)}` : ''}
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
    paddingBottom: 120,
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
  providerHeaderName: {
    ...Typography.SCREEN_TITLE,
    marginLeft: Spacing.M,
    flex: 1,
  },
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
    marginBottom: Spacing.M,
  },
  verifyButton: {
    backgroundColor: Colors.BLUE,
    height: Spacing.BUTTON_HEIGHT_SECONDARY,
    borderRadius: Spacing.BUTTON_RADIUS,
    justifyContent: 'center',
    alignItems: 'center',
  },
  verifyButtonText: { ...Typography.BUTTON_TEXT, color: Colors.WHITE },
  verifiedAccount: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.GREEN_LIGHT,
    borderRadius: Spacing.BUTTON_RADIUS,
    padding: Spacing.M,
  },
  verifiedIcon: { fontSize: 20, color: Colors.GREEN, marginRight: Spacing.M },
  verifiedInfo: { flex: 1 },
  verifiedName: { ...Typography.BODY, fontWeight: '600', color: Colors.DARK },
  verifiedDetails: { ...Typography.CAPTION, color: Colors.GRAY, marginTop: 2 },
  unverifiableAccount: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(245, 158, 11, 0.12)',
    borderRadius: Spacing.BUTTON_RADIUS,
    padding: Spacing.M,
    marginTop: Spacing.M,
  },
  unverifiableIcon: { fontSize: 20, fontWeight: '700', color: Colors.WARNING, marginRight: Spacing.M },
  unverifiableTitle: { ...Typography.BODY, fontWeight: '600', color: Colors.WARNING },
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
  summaryAmount: { ...Typography.AMOUNT_SMALL },
  feeBreakdown: { marginBottom: Spacing.L },
  feeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 2,
  },
  feeLabel: { ...Typography.CAPTION, color: Colors.GRAY },
  feeValue: { ...Typography.CAPTION, color: Colors.DARK },
  feeTotalRow: {
    marginTop: Spacing.S,
    paddingTop: Spacing.S,
    borderTopWidth: 1,
    borderTopColor: Colors.BORDER,
  },
  feeTotalLabel: { ...Typography.BODY, flex: 1, marginRight: Spacing.M },
  primaryButton: {
    height: Spacing.BUTTON_HEIGHT_PRIMARY,
    backgroundColor: Colors.GREEN,
    borderRadius: Spacing.BUTTON_RADIUS,
    justifyContent: 'center',
    alignItems: 'center',
  },
  primaryButtonDisabled: { opacity: 0.5 },
  primaryButtonText: { ...Typography.BUTTON_TEXT },
  resultContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: Spacing.SCREEN_PADDING },
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
});
