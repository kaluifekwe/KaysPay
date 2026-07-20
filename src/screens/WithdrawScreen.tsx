import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Colors } from '../constants/colors';
import { Typography } from '../constants/typography';
import { Spacing } from '../constants/spacing';
import { formatNaira } from '../utils/formatCurrency';
import { walletService } from '../services/wallet.service';
import { paystackService, Bank } from '../services/paystack.service';
import { supabase } from '../lib/supabase';
import { useTransactionAuth } from '../components/TransactionAuthProvider';
import { safeErrorMessage } from '../utils/errorMessages';

interface WithdrawScreenProps {
  navigation: any;
  route: {
    params?: {
      selectedBank?: Bank;
    };
  };
}

const QUICK_AMOUNTS = [1000, 2000, 5000, 10000, 20000, 50000];

export default function WithdrawScreen({ navigation, route }: WithdrawScreenProps) {
  const { authorize } = useTransactionAuth();
  const insets = useSafeAreaInsets();
  const [balance, setBalance] = useState(0);
  const [selectedBank, setSelectedBank] = useState<Bank | null>(null);
  const [accountNumber, setAccountNumber] = useState('');
  const [accountName, setAccountName] = useState('');
  const [verifyingAccount, setVerifyingAccount] = useState(false);
  const [accountVerified, setAccountVerified] = useState(false);
  const [amount, setAmount] = useState('');
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState<'bank' | 'account' | 'amount' | 'confirm'>('bank');

  // Guards against double-submitting a withdrawal. submittingRef blocks
  // concurrent taps synchronously; withdrawalKeyRef is a stable idempotency
  // key the server uses to dedupe retries of the same withdrawal intent.
  const submittingRef = useRef(false);
  const withdrawalKeyRef = useRef<string | null>(null);

  useEffect(() => {
    fetchBalance();
  }, []);

  useEffect(() => {
    if (route.params?.selectedBank) {
      setSelectedBank(route.params.selectedBank);
      setAccountNumber('');
      setAccountName('');
      setAccountVerified(false);
      setStep('account');
    }
  }, [route.params?.selectedBank]);

  const fetchBalance = useCallback(async () => {
    try {
      const result = await walletService.getWallet();
      setBalance(result.wallet?.balance ?? 0);
    } catch (error) {
      console.error('Failed to fetch balance', error);
    }
  }, []);

  const handleVerifyAccount = async () => {
    if (accountNumber.length !== 10) {
      Alert.alert('Invalid Account', 'Account number must be 10 digits');
      return;
    }

    if (!selectedBank) return;

    setVerifyingAccount(true);
    setAccountVerified(false);
    setAccountName('');

    const result = await paystackService.resolveAccount(accountNumber, selectedBank.code);

    setVerifyingAccount(false);

    if (!result.success || !result.data) {
      Alert.alert('Verification Failed', result.error || 'Could not verify account');
      return;
    }

    setAccountName(result.data.account_name);
    setAccountVerified(true);
    setStep('amount');
  };

  const getAmount = (): number => {
    const parsed = parseFloat(amount);
    return isNaN(parsed) ? 0 : parsed;
  };

  const getFee = (): number => {
    return paystackService.calculateFee(getAmount());
  };

  const getTotalDeduction = (): number => {
    return getAmount() + getFee();
  };

  // Explains why the Withdraw button is disabled — otherwise it just looks broken.
  const getDisabledReason = (): string | null => {
    const amt = getAmount();
    if (amt <= 0) return null;
    if (amt < 100) return 'Minimum withdrawal is ₦100';
    if (getTotalDeduction() > balance) {
      return `Insufficient balance — you need ${formatNaira(getTotalDeduction())} (amount + fee) but have ${formatNaira(balance)}`;
    }
    return null;
  };

  const handleQuickAmount = (value: number) => {
    setAmount(value.toString());
  };

  const handleAmountChange = (text: string) => {
    const cleaned = text.replace(/[^0-9.]/g, '');
    setAmount(cleaned);
  };

  const handleWithdraw = async () => {
    const withdrawAmount = getAmount();

    if (withdrawAmount < 100) {
      Alert.alert('Minimum Amount', 'Minimum withdrawal is ₦100');
      return;
    }

    if (withdrawAmount > 500000) {
      Alert.alert('Maximum Amount', 'Maximum withdrawal per transaction is ₦500,000');
      return;
    }

    if (getTotalDeduction() > balance) {
      Alert.alert(
        'Insufficient Balance',
        `You need ${formatNaira(getTotalDeduction())} (amount + fee) but have ${formatNaira(balance)}`
      );
      return;
    }

    if (!selectedBank || !accountVerified || !accountName) return;

    // Show confirmation
    Alert.alert(
      'Confirm Withdrawal',
      `Withdraw ${formatNaira(withdrawAmount)} to:\n\n${accountName}\n${selectedBank.name}\n${accountNumber}\n\nFee: ${formatNaira(getFee())}\nTotal: ${formatNaira(getTotalDeduction())}`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Confirm',
          onPress: () => processWithdrawal(withdrawAmount),
        },
      ]
    );
  };

  const processWithdrawal = async (withdrawAmount: number) => {
    // Synchronous guard: ignore a second tap while one is already in flight.
    if (submittingRef.current) return;
    submittingRef.current = true;

    try {
      const authResult = await authorize({ title: 'Confirm Withdrawal', amount: withdrawAmount });
      if (!authResult) return;

      // Stable key for this withdrawal intent — reused if the request is
      // retried so the server never debits twice.
      if (!withdrawalKeyRef.current) {
        withdrawalKeyRef.current = `kpwd_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      }

      setLoading(true);

      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        Alert.alert('Error', 'You must be logged in');
        return;
      }

      const result = await paystackService.initiateTransfer({
        amount: withdrawAmount,
        account_number: accountNumber,
        bank_code: selectedBank!.code,
        account_name: accountName,
        bank_name: selectedBank!.name,
        idempotency_key: withdrawalKeyRef.current,
        authToken: authResult.token,
      });

      if (!result.success) {
        // Failed/refunded → next attempt is a fresh intent.
        withdrawalKeyRef.current = null;
        Alert.alert('Withdrawal Failed', result.error || 'Please try again');
        return;
      }

      withdrawalKeyRef.current = null;
      Alert.alert(
        'Withdrawal Initiated',
        `Your withdrawal of ${formatNaira(withdrawAmount)} to ${accountName} has been initiated. You will receive a notification when it completes.`,
        [
          {
            text: 'OK',
            onPress: () => navigation.goBack(),
          },
        ]
      );
    } catch (error: any) {
      Alert.alert('Error', safeErrorMessage(error, 'Something went wrong. Please try again.'));
    } finally {
      setLoading(false);
      submittingRef.current = false;
    }
  };

  const handleGoToBankList = () => {
    navigation.navigate('BankList');
  };

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right']}>
      <KeyboardAvoidingView
        style={styles.keyboardView}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.container}>
          <View style={styles.header}>
            <TouchableOpacity
              style={styles.backButton}
              onPress={() => {
                if (step === 'amount' || step === 'confirm') {
                  setStep('account');
                } else if (step === 'account') {
                  setStep('bank');
                } else {
                  navigation.goBack();
                }
              }}
            >
              <Text style={styles.backText}>{'<'}</Text>
            </TouchableOpacity>
          </View>

          <ScrollView
            style={styles.scrollView}
            contentContainerStyle={styles.scrollContent}
            keyboardShouldPersistTaps="handled"
          >
            <Text style={styles.title}>Withdraw to Bank</Text>

            <View style={styles.balanceCard}>
              <Text style={styles.balanceLabel}>Available Balance</Text>
              <Text style={styles.balanceAmount}>{formatNaira(balance)}</Text>
            </View>

            {/* Step 1: Select Bank */}
            <View style={[styles.stepContainer, step !== 'bank' && styles.stepCompleted]}>
              <View style={[styles.stepIndicator, step !== 'bank' && styles.stepIndicatorActive]}>
                <Text style={[styles.stepNumber, step !== 'bank' && styles.stepNumberActive]}>
                  {step !== 'bank' ? '✓' : '1'}
                </Text>
              </View>
              <Text style={styles.stepLabel}>Select Bank</Text>
            </View>

            {step === 'bank' && (
              <TouchableOpacity
                style={styles.bankSelector}
                onPress={handleGoToBankList}
              >
                <Text style={styles.bankSelectorText}>
                  {selectedBank ? selectedBank.name : 'Tap to select bank'}
                </Text>
                <Text style={styles.bankSelectorArrow}>›</Text>
              </TouchableOpacity>
            )}

            {selectedBank && step !== 'bank' && (
              <View style={styles.selectedBankChip}>
                <Text style={styles.selectedBankText}>🏦 {selectedBank.name}</Text>
              </View>
            )}

            {/* Step 2: Account Number */}
            <View style={[styles.stepContainer, step !== 'account' && step !== 'bank' && styles.stepCompleted, step === 'bank' && styles.stepDisabled]}>
              <View style={[styles.stepIndicator, (step === 'account' || step === 'amount') && styles.stepIndicatorActive]}>
                <Text style={[styles.stepNumber, (step === 'account' || step === 'amount') && styles.stepNumberActive]}>
                  {accountVerified ? '✓' : '2'}
                </Text>
              </View>
              <Text style={styles.stepLabel}>Account Number</Text>
            </View>

            {(step === 'account' || step === 'amount' || step === 'confirm') && selectedBank && (
              <>
                <View style={styles.inputContainer}>
                  <TextInput
                    style={styles.input}
                    value={accountNumber}
                    onChangeText={(text) => {
                      const cleaned = text.replace(/[^0-9]/g, '').slice(0, 10);
                      setAccountNumber(cleaned);
                      setAccountVerified(false);
                      setAccountName('');
                    }}
                    placeholder="Enter 10-digit account number"
                    placeholderTextColor={Colors.GRAY}
                    keyboardType="numeric"
                    maxLength={10}
                  />
                </View>

                {!accountVerified && accountNumber.length === 10 && (
                  <TouchableOpacity
                    style={styles.verifyButton}
                    onPress={handleVerifyAccount}
                    disabled={verifyingAccount}
                  >
                    {verifyingAccount ? (
                      <ActivityIndicator size="small" color={Colors.WHITE} />
                    ) : (
                      <Text style={styles.verifyButtonText}>Verify Account</Text>
                    )}
                  </TouchableOpacity>
                )}

                {accountVerified && accountName && (
                  <View style={styles.verifiedAccount}>
                    <Text style={styles.verifiedIcon}>✓</Text>
                    <View style={styles.verifiedInfo}>
                      <Text style={styles.verifiedName}>{accountName}</Text>
                      <Text style={styles.verifiedDetails}>
                        {selectedBank?.name} • {accountNumber}
                      </Text>
                    </View>
                  </View>
                )}
              </>
            )}

            {/* Step 3: Amount */}
            <View style={[styles.stepContainer, step === 'bank' && styles.stepDisabled, step === 'account' && !accountVerified && styles.stepDisabled]}>
              <View style={[styles.stepIndicator, step === 'confirm' && styles.stepIndicatorActive]}>
                <Text style={[styles.stepNumber, step === 'confirm' && styles.stepNumberActive]}>3</Text>
              </View>
              <Text style={styles.stepLabel}>Amount</Text>
            </View>

            {(step === 'amount' || step === 'confirm') && accountVerified && (
              <>
                <Text style={styles.sectionTitle}>Withdrawal Amount</Text>
                <View style={styles.quickAmountsGrid}>
                  {QUICK_AMOUNTS.map((quickAmount) => (
                    <TouchableOpacity
                      key={quickAmount}
                      style={[
                        styles.quickAmountButton,
                        amount === quickAmount.toString() && styles.quickAmountSelected,
                      ]}
                      onPress={() => handleQuickAmount(quickAmount)}
                    >
                      <Text
                        style={[
                          styles.quickAmountText,
                          amount === quickAmount.toString() && styles.quickAmountTextSelected,
                        ]}
                      >
                        {formatNaira(quickAmount)}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>

                <Text style={styles.sectionTitle}>Custom Amount</Text>
                <View style={styles.amountInputContainer}>
                  <Text style={styles.currencySymbol}>₦</Text>
                  <TextInput
                    style={styles.amountInput}
                    value={amount}
                    onChangeText={handleAmountChange}
                    placeholder="Enter amount"
                    placeholderTextColor={Colors.GRAY}
                    keyboardType="numeric"
                  />
                </View>

                {getAmount() > 0 && (
                  <View style={styles.feeContainer}>
                    <View style={styles.feeRow}>
                      <Text style={styles.feeLabel}>Amount</Text>
                      <Text style={styles.feeValue}>{formatNaira(getAmount())}</Text>
                    </View>
                    <View style={styles.feeRow}>
                      <Text style={styles.feeLabel}>Fee</Text>
                      <Text style={styles.feeValue}>{formatNaira(getFee())}</Text>
                    </View>
                    <View style={styles.feeDivider} />
                    <View style={styles.feeRow}>
                      <Text style={styles.feeTotalLabel}>Total Deduction</Text>
                      <Text style={styles.feeTotalValue}>{formatNaira(getTotalDeduction())}</Text>
                    </View>
                  </View>
                )}

                {getDisabledReason() && (
                  <Text style={styles.disabledReasonText}>{getDisabledReason()}</Text>
                )}
              </>
            )}
          </ScrollView>

          {/* Withdraw Button — fixed to the bottom like every other screen. */}
          {(step === 'amount' || step === 'confirm') && accountVerified && (
            <View style={[styles.bottomBar, { paddingBottom: insets.bottom + Spacing.M }]}>
              <TouchableOpacity
                style={[
                  styles.withdrawButton,
                  (getAmount() < 100 || loading || getTotalDeduction() > balance) &&
                    styles.withdrawButtonDisabled,
                ]}
                onPress={handleWithdraw}
                disabled={getAmount() < 100 || loading || getTotalDeduction() > balance}
              >
                {loading ? (
                  <ActivityIndicator size="small" color={Colors.WHITE} />
                ) : (
                  <Text style={styles.withdrawButtonText}>
                    Withdraw {getAmount() > 0 ? formatNaira(getAmount()) : ''}
                  </Text>
                )}
              </TouchableOpacity>
            </View>
          )}
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: Colors.WHITE,
  },
  keyboardView: {
    flex: 1,
  },
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.SCREEN_PADDING,
    paddingTop: Spacing.S,
    paddingBottom: Spacing.XS,
  },
  backButton: {
    width: 48,
    height: 48,
    justifyContent: 'center',
    alignItems: 'center',
  },
  backText: {
    fontSize: 28,
    fontWeight: '600',
    color: Colors.DARK,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: Spacing.SCREEN_PADDING,
    paddingBottom: 120,
  },
  title: {
    ...Typography.SCREEN_TITLE,
    marginTop: Spacing.S,
    marginBottom: Spacing.L,
  },
  balanceCard: {
    backgroundColor: Colors.GREEN,
    borderRadius: Spacing.BUTTON_RADIUS,
    padding: Spacing.L,
    marginBottom: Spacing.L,
  },
  balanceLabel: {
    ...Typography.CAPTION,
    color: Colors.WHITE,
    opacity: 0.8,
    marginBottom: Spacing.XS,
  },
  balanceAmount: {
    fontFamily: 'Helvetica-Bold',
    color: Colors.WHITE,
    fontSize: 32,
    lineHeight: 38,
  },
  stepContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: Spacing.M,
  },
  stepCompleted: {
    opacity: 0.6,
  },
  stepDisabled: {
    opacity: 0.4,
  },
  stepIndicator: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: Colors.LIGHT_GRAY,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: Spacing.M,
  },
  stepIndicatorActive: {
    backgroundColor: Colors.GREEN_LIGHT,
  },
  stepNumber: {
    ...Typography.CAPTION,
    fontWeight: '600',
    color: Colors.GRAY,
  },
  stepNumberActive: {
    color: Colors.GREEN,
  },
  stepLabel: {
    ...Typography.BODY,
    fontWeight: '500',
    color: Colors.DARK,
  },
  bankSelector: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: Spacing.INPUT_BORDER_WIDTH,
    borderColor: Colors.BORDER,
    borderRadius: Spacing.BUTTON_RADIUS,
    height: Spacing.INPUT_HEIGHT,
    paddingHorizontal: Spacing.M,
    marginBottom: Spacing.L,
    backgroundColor: Colors.WHITE,
  },
  bankSelectorText: {
    ...Typography.BODY,
    color: Colors.GRAY,
  },
  bankSelectorArrow: {
    fontSize: 24,
    color: Colors.GRAY,
  },
  selectedBankChip: {
    backgroundColor: Colors.GREEN_LIGHT,
    borderRadius: Spacing.BUTTON_RADIUS,
    paddingVertical: Spacing.S,
    paddingHorizontal: Spacing.M,
    marginBottom: Spacing.L,
    alignSelf: 'flex-start',
  },
  selectedBankText: {
    ...Typography.BODY,
    color: Colors.GREEN_DARK,
    fontWeight: '500',
  },
  inputContainer: {
    borderWidth: Spacing.INPUT_BORDER_WIDTH,
    borderColor: Colors.BORDER,
    borderRadius: Spacing.BUTTON_RADIUS,
    height: Spacing.INPUT_HEIGHT,
    paddingHorizontal: Spacing.M,
    marginBottom: Spacing.M,
    backgroundColor: Colors.WHITE,
  },
  input: {
    flex: 1,
    ...Typography.BODY,
    color: Colors.DARK,
    height: '100%',
    letterSpacing: 2,
  },
  verifyButton: {
    backgroundColor: Colors.BLUE,
    height: Spacing.BUTTON_HEIGHT_SECONDARY,
    borderRadius: Spacing.BUTTON_RADIUS,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: Spacing.L,
  },
  verifyButtonText: {
    ...Typography.BUTTON_TEXT,
    color: Colors.WHITE,
  },
  verifiedAccount: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.GREEN_LIGHT,
    borderRadius: Spacing.BUTTON_RADIUS,
    padding: Spacing.M,
    marginBottom: Spacing.L,
  },
  verifiedIcon: {
    fontSize: 20,
    color: Colors.GREEN,
    marginRight: Spacing.M,
  },
  verifiedInfo: {
    flex: 1,
  },
  verifiedName: {
    ...Typography.BODY,
    fontWeight: '600',
    color: Colors.DARK,
  },
  verifiedDetails: {
    ...Typography.CAPTION,
    color: Colors.GRAY,
    marginTop: 2,
  },
  sectionTitle: {
    ...Typography.SECTION_HEADING,
    marginBottom: Spacing.M,
  },
  quickAmountsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.S,
    marginBottom: Spacing.L,
  },
  quickAmountButton: {
    width: '30%',
    paddingVertical: Spacing.M,
    borderRadius: Spacing.BUTTON_RADIUS,
    borderWidth: Spacing.INPUT_BORDER_WIDTH,
    borderColor: Colors.BORDER,
    alignItems: 'center',
    backgroundColor: Colors.WHITE,
  },
  quickAmountSelected: {
    backgroundColor: Colors.GREEN_LIGHT,
    borderColor: Colors.GREEN,
  },
  quickAmountText: {
    ...Typography.BODY,
    fontWeight: '600',
    color: Colors.DARK,
  },
  quickAmountTextSelected: {
    color: Colors.GREEN_DARK,
  },
  amountInputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: Spacing.INPUT_BORDER_WIDTH,
    borderColor: Colors.BORDER,
    borderRadius: Spacing.BUTTON_RADIUS,
    height: Spacing.INPUT_HEIGHT,
    paddingHorizontal: Spacing.M,
    marginBottom: Spacing.L,
    backgroundColor: Colors.WHITE,
  },
  currencySymbol: {
    ...Typography.BODY,
    color: Colors.GRAY,
    marginRight: Spacing.S,
  },
  amountInput: {
    flex: 1,
    ...Typography.BODY,
    color: Colors.DARK,
    height: '100%',
  },
  feeContainer: {
    backgroundColor: Colors.LIGHT_GRAY,
    borderRadius: Spacing.BUTTON_RADIUS,
    padding: Spacing.M,
    marginBottom: Spacing.L,
  },
  feeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: Spacing.S,
  },
  feeLabel: {
    ...Typography.CAPTION,
    color: Colors.GRAY,
  },
  feeValue: {
    ...Typography.CAPTION,
    color: Colors.DARK,
  },
  feeDivider: {
    height: 1,
    backgroundColor: Colors.BORDER,
    marginVertical: Spacing.S,
  },
  feeTotalLabel: {
    ...Typography.BODY,
    fontWeight: '600',
    color: Colors.DARK,
  },
  feeTotalValue: {
    ...Typography.BODY,
    fontWeight: '700',
    color: Colors.GREEN_DARK,
  },
  disabledReasonText: {
    ...Typography.ERROR,
    marginBottom: Spacing.M,
    textAlign: 'center',
  },
  bottomBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: Colors.WHITE,
    borderTopWidth: 1,
    borderTopColor: Colors.BORDER,
    paddingHorizontal: Spacing.SCREEN_PADDING,
    paddingTop: Spacing.M,
  },
  withdrawButton: {
    backgroundColor: Colors.GREEN,
    height: Spacing.BUTTON_HEIGHT_PRIMARY,
    borderRadius: Spacing.BUTTON_RADIUS,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: Spacing.M,
  },
  withdrawButtonDisabled: {
    opacity: 0.5,
  },
  withdrawButtonText: {
    ...Typography.BUTTON_TEXT,
    color: Colors.WHITE,
  },
});
