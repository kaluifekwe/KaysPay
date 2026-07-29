import React, { useState, useEffect, useCallback } from 'react';
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
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { Colors } from '../constants/colors';
import { Typography } from '../constants/typography';
import { Spacing } from '../constants/spacing';
import { formatNaira } from '../utils/formatCurrency';
import { walletService } from '../services/wallet.service';
import { virtualAccountService, VirtualAccount } from '../services/virtualAccount.service';
import { supabase } from '../lib/supabase';
import { useCachedData } from '../hooks/useCachedData';

const QUICK_AMOUNTS = [500, 1000, 2000, 5000, 10000, 20000];

// Bank-transfer funding runs on Flutterwave Fixed Virtual Accounts, offered
// alongside Paystack. Re-enabled 2026-07-26 after fixing the auth blocker
// (live OAuth credentials were rejected) and configuring the live webhook.
// The stale 2026-07-04 account (which had gone missing on Flutterwave's
// side after the credential regeneration) was cleared so the app provisions
// a fresh account under the current valid credentials. Under live testing.
const BANK_TRANSFER_FUNDING_ENABLED = true;

const WalletFundingScreen: React.FC<{ navigation: any }> = ({ navigation }) => {
  const [selectedAmount, setSelectedAmount] = useState<number | null>(null);
  const [customAmount, setCustomAmount] = useState('');
  const [loading, setLoading] = useState(false);
  const [account, setAccount] = useState<VirtualAccount | null>(null);
  const [accountLoading, setAccountLoading] = useState(false);
  // True until the first getMine() resolves — so users who already have an
  // account see a loader instead of a flash of "Get my account number".
  const [accountInitialLoading, setAccountInitialLoading] = useState(BANK_TRANSFER_FUNDING_ENABLED);
  const [showBvnInput, setShowBvnInput] = useState(false);
  const [bvnOrNin, setBvnOrNin] = useState('');

  // Shows the last-known balance immediately (even on a bad connection),
  // then quietly refreshes in the background. A failed refresh never wipes
  // out a real cached balance to show ₦0.00 — that's the "genuinely empty
  // wallet" and "we couldn't check" cases looking identical, which is
  // exactly the confusion this replaced.
  const fetchBalanceOrThrow = useCallback(async () => {
    const result = await walletService.getWallet();
    if (!result.success) throw new Error(result.error || 'Could not load balance');
    return result.wallet?.balance ?? 0;
  }, []);
  const {
    data: balance,
    loading: balanceLoading,
    isStale: balanceStale,
    error: balanceError,
    refresh: fetchBalance,
  } = useCachedData('wallet_balance', fetchBalanceOrThrow);

  useEffect(() => {
    if (!BANK_TRANSFER_FUNDING_ENABLED) {
      setAccountInitialLoading(false);
      return;
    }
    virtualAccountService
      .getMine()
      .then(setAccount)
      .finally(() => setAccountInitialLoading(false));
  }, []);

  // Keep the balance current without the user having to leave and come back:
  // refresh when the screen regains focus (e.g. returning from the Paystack
  // checkout) and poll while it's open so a bank transfer that lands reflects
  // here on its own.
  useFocusEffect(
    useCallback(() => {
      fetchBalance();
      const id = setInterval(fetchBalance, 10000);
      return () => clearInterval(id);
    }, [fetchBalance]),
  );

  const handleGetAccount = async () => {
    if (!/^\d{11}$/.test(bvnOrNin)) {
      Alert.alert('Bank Transfer', 'Please enter a valid 11-digit BVN or NIN.');
      return;
    }
    setAccountLoading(true);
    const res = await virtualAccountService.create(bvnOrNin);
    setAccountLoading(false);
    if (res.success && res.account) {
      setAccount(res.account);
      setShowBvnInput(false);
    } else {
      Alert.alert('Bank Transfer', res.error || 'Could not set up your account number.');
    }
  };

  const getAmount = (): number => {
    if (selectedAmount) return selectedAmount;
    const parsed = parseFloat(customAmount);
    return isNaN(parsed) ? 0 : parsed;
  };

  const handleQuickAmount = (amount: number) => {
    setSelectedAmount(amount);
    setCustomAmount('');
  };

  const handleCustomAmountChange = (text: string) => {
    const cleaned = text.replace(/[^0-9.]/g, '');
    setCustomAmount(cleaned);
    setSelectedAmount(null);
  };

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <KeyboardAvoidingView
        style={styles.keyboardView}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.container}>
          <View style={styles.header}>
            <TouchableOpacity
              style={styles.backButton}
              onPress={() => navigation.goBack()}
            >
              <Text style={styles.backText}>{'<'}</Text>
            </TouchableOpacity>
          </View>

          <ScrollView
            style={styles.scrollView}
            contentContainerStyle={styles.scrollContent}
            keyboardShouldPersistTaps="handled"
          >
            <Text style={styles.title}>Fund Wallet</Text>

            <TouchableOpacity
              style={styles.balanceCard}
              onPress={fetchBalance}
              activeOpacity={0.7}
              disabled={balanceLoading && balance === null}
            >
              <Text style={styles.balanceLabel}>Current Balance</Text>
              {balanceLoading && balance === null ? (
                <ActivityIndicator color={Colors.WHITE} />
              ) : balanceError ? (
                <>
                  <Text style={styles.balanceErrorText}>Couldn't load balance</Text>
                  <Text style={styles.balanceRetryText}>Tap to retry</Text>
                </>
              ) : (
                <>
                  <Text style={styles.balanceAmount}>{formatNaira(balance ?? 0)}</Text>
                  {balanceStale && (
                    <Text style={styles.balanceRetryText}>
                      {balanceLoading ? 'Updating…' : 'May be outdated — tap to refresh'}
                    </Text>
                  )}
                </>
              )}
            </TouchableOpacity>

            {BANK_TRANSFER_FUNDING_ENABLED && (
              <>
                <Text style={styles.sectionTitle}>Fund by Bank Transfer</Text>
                {account ? (
                  <View style={styles.transferCard}>
                    <Text style={styles.transferHint}>
                      Transfer any amount to this account. Your wallet is credited automatically.
                    </Text>
                    <View style={styles.transferRow}>
                      <Text style={styles.transferLabel}>Bank</Text>
                      <Text style={styles.transferValue}>{account.bank_name}</Text>
                    </View>
                    <View style={styles.transferRow}>
                      <Text style={styles.transferLabel}>Account Number</Text>
                      <Text style={styles.transferAccount} selectable>
                        {account.account_number}
                      </Text>
                    </View>
                    <View style={styles.transferRow}>
                      <Text style={styles.transferLabel}>Account Name</Text>
                      <Text style={styles.transferValue}>{account.account_name}</Text>
                    </View>
                  </View>
                ) : accountInitialLoading ? (
                  <View style={styles.transferCard}>
                    <ActivityIndicator color={Colors.GREEN} />
                  </View>
                ) : showBvnInput ? (
                  <View style={styles.transferCard}>
                    <Text style={styles.transferHint}>
                      We need your BVN or NIN once to set up your dedicated account number, as required by our banking partner.
                    </Text>
                    <View style={styles.inputContainer}>
                      <TextInput
                        style={styles.input}
                        value={bvnOrNin}
                        onChangeText={(t) => setBvnOrNin(t.replace(/[^0-9]/g, '').slice(0, 11))}
                        placeholder="Enter your BVN or NIN"
                        placeholderTextColor={Colors.GRAY}
                        keyboardType="number-pad"
                        maxLength={11}
                      />
                    </View>
                    <TouchableOpacity
                      style={[
                        styles.transferButton,
                        bvnOrNin.length !== 11 && styles.fundButtonDisabled,
                      ]}
                      onPress={handleGetAccount}
                      disabled={accountLoading || bvnOrNin.length !== 11}
                    >
                      {accountLoading ? (
                        <ActivityIndicator color={Colors.GREEN} />
                      ) : (
                        <Text style={styles.transferButtonText}>Continue</Text>
                      )}
                    </TouchableOpacity>
                  </View>
                ) : (
                  <TouchableOpacity
                    style={styles.transferButton}
                    onPress={() => setShowBvnInput(true)}
                  >
                    <Text style={styles.transferButtonText}>Get my account number</Text>
                  </TouchableOpacity>
                )}
              </>
            )}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
};

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
    paddingBottom: Spacing.XL,
  },
  title: {
    ...Typography.SCREEN_TITLE,
    marginTop: Spacing.S,
    marginBottom: Spacing.L,
  },
  balanceCard: {
    backgroundColor: Colors.GREEN,
    borderRadius: 12,
    paddingHorizontal: Spacing.L,
    paddingVertical: Spacing.XL,
    marginBottom: Spacing.L,
  },
  balanceLabel: {
    ...Typography.CAPTION,
    color: Colors.WHITE_80,
    marginBottom: Spacing.S,
  },
  balanceAmount: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 32,
    color: Colors.WHITE,
  },
  balanceErrorText: {
    ...Typography.BODY,
    fontWeight: '700',
    color: Colors.WHITE,
  },
  balanceRetryText: {
    ...Typography.CAPTION,
    color: Colors.WHITE_80,
    marginTop: 2,
  },
  dividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: Spacing.L,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: Colors.BORDER,
  },
  dividerText: {
    ...Typography.CAPTION,
    color: Colors.GRAY,
    marginHorizontal: Spacing.M,
  },
  transferButton: {
    height: Spacing.BUTTON_HEIGHT_PRIMARY,
    borderRadius: Spacing.BUTTON_RADIUS,
    borderWidth: 1,
    borderColor: Colors.GREEN,
    justifyContent: 'center',
    alignItems: 'center',
  },
  transferButtonText: {
    ...Typography.BUTTON_TEXT,
    color: Colors.GREEN,
  },
  transferCard: {
    backgroundColor: Colors.LIGHT_GRAY,
    borderRadius: 12,
    padding: Spacing.L,
  },
  transferHint: {
    ...Typography.CAPTION,
    color: Colors.GRAY,
    marginBottom: Spacing.M,
  },
  transferRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: Spacing.S,
  },
  transferLabel: {
    ...Typography.BODY,
    color: Colors.GRAY,
  },
  transferValue: {
    ...Typography.BODY,
    color: Colors.DARK,
    fontWeight: '600',
    flexShrink: 1,
    textAlign: 'right',
    marginLeft: Spacing.M,
  },
  transferAccount: {
    ...Typography.HEADING,
    color: Colors.GREEN,
    fontWeight: '700',
    letterSpacing: 1,
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
  inputContainer: {
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
  input: {
    flex: 1,
    ...Typography.BODY,
    color: Colors.DARK,
    height: '100%',
  },
  fundButton: {
    backgroundColor: Colors.GREEN,
    height: Spacing.BUTTON_HEIGHT_PRIMARY,
    borderRadius: Spacing.BUTTON_RADIUS,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: Spacing.M,
  },
  fundButtonDisabled: {
    opacity: 0.5,
  },
  fundButtonText: {
    ...Typography.BUTTON_TEXT,
    color: Colors.WHITE,
  },
});

export default WalletFundingScreen;
