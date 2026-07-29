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
  Alert,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Colors } from '../constants/colors';
import { Typography } from '../constants/typography';
import { Spacing } from '../constants/spacing';
import { formatNaira } from '../utils/formatCurrency';
import { vtuService, type ElectricityProvider } from '../services/vtu.service';
import { useTransactionAuth } from '../components/TransactionAuthProvider';
import ProviderLogo from '../components/ProviderLogo';
import { ELECTRICITY_LOGOS } from '../utils/providerLogos';
import { downloadPdf, sharePdf } from '../utils/pdf';
import { buildElectricityReceiptHtml } from '../utils/receipts';

type BuyState = 'idle' | 'processing' | 'success' | 'error';

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

  const numericAmount = useMemo(() => parseInt(amount, 10), [amount]);
  const isValidAmount = !isNaN(numericAmount) && numericAmount >= 500 && numericAmount <= 500000;
  const isValidMeter = meterNumber.trim().length >= 6;
  const canProceed = isValidMeter && isValidAmount && buyState !== 'processing';

  const handleMeterChange = useCallback((text: string) => {
    setMeterNumber(text.replace(/[^0-9]/g, '').slice(0, 13));
  }, []);

  const handleQuickAmount = useCallback((quickAmount: number) => {
    setAmount(quickAmount.toString());
    Keyboard.dismiss();
  }, []);

  const handleAmountChange = useCallback((text: string) => {
    setAmount(text.replace(/[^0-9]/g, '').slice(0, 6));
  }, []);

  const handlePay = useCallback(async () => {
    if (!canProceed) return;

    const authResult = await authorize({ title: 'Confirm Electricity Payment', amount: numericAmount });
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
      electricity: { providerName: provider.name, meterType: provider.type },
      request: {
        kind: 'electricity',
        providerId: provider.id,
        meterNumber: meterNumber.trim(),
        amount: numericAmount,
        type: provider.type,
        authToken: authResult.token,
      },
    });
  }, [canProceed, provider, meterNumber, numericAmount, navigation, authorize]);

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
            <TextInput
              style={styles.input}
              value={meterNumber}
              onChangeText={handleMeterChange}
              placeholder="Enter meter number"
              placeholderTextColor={Colors.GRAY}
              keyboardType="number-pad"
              maxLength={13}
            />
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
