import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { Typography } from '../constants/typography';
import { Spacing } from '../constants/spacing';
import { AppTheme } from '../constants/theme';
import { useTheme } from '../components/ThemeProvider';
import { formatNaira } from '../utils/formatCurrency';
import { walletService } from '../services/wallet.service';
import { virtualAccountService, VirtualAccount, VirtualAccountProvider } from '../services/virtualAccount.service';
import ProviderFundingBlock from '../components/ProviderFundingBlock';
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
// Paystack Dedicated Virtual Accounts are offered alongside Flutterwave.
// Paystack account creation and deposit crediting stay fully server-side.
const PAYSTACK_FUNDING_ENABLED = true;

const WalletFundingScreen: React.FC<{ navigation: any }> = ({ navigation }) => {
  const { theme } = useTheme();
  const styles = createStyles(theme);
  const [selectedAmount, setSelectedAmount] = useState<number | null>(null);
  const [customAmount, setCustomAmount] = useState('');
  const [loading, setLoading] = useState(false);
  const [realtimeBalance, setRealtimeBalance] = useState<number | null>(null);
  const [paystackCheckStatus, setPaystackCheckStatus] = useState<'idle' | 'checking' | 'credited' | 'waiting'>('idle');
  const paystackCheckStatusRef = useRef(paystackCheckStatus);
  const displayedBalanceRef = useRef<number | null>(null);
  const rapidCheckIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const rapidCheckTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    paystackCheckStatusRef.current = paystackCheckStatus;
  }, [paystackCheckStatus]);

  const [accounts, setAccounts] = useState<Record<VirtualAccountProvider, VirtualAccount | null>>({
    flutterwave: null,
    paystack: null,
  });
  // True until the first getAllMine() resolves — so users who already have
  // an account see a loader instead of a flash of "Get my account number".
  const [accountsInitialLoading, setAccountsInitialLoading] = useState(BANK_TRANSFER_FUNDING_ENABLED);

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
    displayedBalanceRef.current = realtimeBalance ?? balance;
  }, [balance, realtimeBalance]);

  useEffect(() => {
    if (!BANK_TRANSFER_FUNDING_ENABLED) {
      setAccountsInitialLoading(false);
      return;
    }
    virtualAccountService
      .getAllMine()
      .then(setAccounts)
      .finally(() => setAccountsInitialLoading(false));
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

  // Refresh immediately when a funding webhook changes this user's wallet.
  // The 10-second poll above remains as a fallback if Realtime is unavailable
  // on a weak connection; the subscription removes that polling delay during
  // normal operation without changing any server-side crediting logic.
  useEffect(() => {
    const subscription = walletService.subscribeToBalance(
      (newBalance) => {
        const previousBalance = displayedBalanceRef.current;
        displayedBalanceRef.current = newBalance;
        setRealtimeBalance(newBalance);
        if (
          paystackCheckStatusRef.current === 'checking' &&
          previousBalance !== null &&
          newBalance > previousBalance
        ) {
          setPaystackCheckStatus('credited');
        }
      },
      (status) => {
        if (status === 'SUBSCRIBED') fetchBalance();
      },
    );
    return () => subscription.unsubscribe();
  }, [fetchBalance]);

  const stopRapidBalanceCheck = useCallback(() => {
    if (rapidCheckIntervalRef.current) clearInterval(rapidCheckIntervalRef.current);
    if (rapidCheckTimeoutRef.current) clearTimeout(rapidCheckTimeoutRef.current);
    rapidCheckIntervalRef.current = null;
    rapidCheckTimeoutRef.current = null;
  }, []);

  const startPaystackBalanceCheck = useCallback(() => {
    stopRapidBalanceCheck();
    setPaystackCheckStatus('checking');
    const startingBalance = realtimeBalance ?? balance ?? 0;
    let checkInFlight = false;

    const check = async () => {
      if (checkInFlight) return;
      checkInFlight = true;
      try {
        const result = await walletService.getWallet();
        const newBalance = result.wallet?.balance;
        if (result.success && typeof newBalance === 'number') {
          setRealtimeBalance(newBalance);
          if (newBalance > startingBalance) {
            stopRapidBalanceCheck();
            setPaystackCheckStatus('credited');
          }
        }
      } finally {
        checkInFlight = false;
      }
    };

    void check();
    rapidCheckIntervalRef.current = setInterval(() => void check(), 2000);
    rapidCheckTimeoutRef.current = setTimeout(() => {
      stopRapidBalanceCheck();
      setPaystackCheckStatus('waiting');
    }, 60000);
  }, [balance, realtimeBalance, stopRapidBalanceCheck]);

  const stopPaystackBalanceCheck = useCallback(() => {
    stopRapidBalanceCheck();
    setPaystackCheckStatus('idle');
  }, [stopRapidBalanceCheck]);

  useEffect(() => stopRapidBalanceCheck, [stopRapidBalanceCheck]);

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
                <ActivityIndicator color="#FFFFFF" />
              ) : balanceError ? (
                <>
                  <Text style={styles.balanceErrorText}>Couldn't load balance</Text>
                  <Text style={styles.balanceRetryText}>Tap to retry</Text>
                </>
              ) : (
                <>
                  <Text style={styles.balanceAmount}>{formatNaira(realtimeBalance ?? balance ?? 0)}</Text>
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
                <Text style={styles.cbnNotice}>
                  Nigerian banking regulation (CBN) requires a BVN or NIN to issue any dedicated
                  account number. This is a standard, one-time step — your details are sent
                  securely and used only to set up your account.
                </Text>
                <ProviderFundingBlock
                  provider="flutterwave"
                  providerLabel="Flutterwave"
                  account={accounts.flutterwave}
                  initialLoading={accountsInitialLoading}
                  onCreated={(acct) => setAccounts((prev) => ({ ...prev, flutterwave: acct }))}
                />
                {PAYSTACK_FUNDING_ENABLED && (
                  <ProviderFundingBlock
                    provider="paystack"
                    providerLabel="Paystack"
                    account={accounts.paystack}
                    initialLoading={accountsInitialLoading}
                    onCreated={(acct) => setAccounts((prev) => ({ ...prev, paystack: acct }))}
                    onPaystackCheckStarted={startPaystackBalanceCheck}
                    onPaystackCheckFailed={stopPaystackBalanceCheck}
                  />
                )}
                {paystackCheckStatus !== 'idle' && (
                  <Text style={styles.paystackCheckText} accessibilityLiveRegion="polite">
                    {paystackCheckStatus === 'checking'
                      ? 'Checking your Paystack transfer…'
                      : paystackCheckStatus === 'credited'
                        ? 'Transfer detected — wallet credited.'
                        : 'Transfer not confirmed yet. Your wallet will update automatically when Paystack confirms it.'}
                  </Text>
                )}
              </>
            )}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
};

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: theme.background,
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
    color: theme.ink,
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
    color: theme.ink,
    marginTop: Spacing.S,
    marginBottom: Spacing.L,
  },
  balanceCard: {
    backgroundColor: theme.brand,
    borderRadius: 12,
    paddingHorizontal: Spacing.L,
    paddingVertical: Spacing.XL,
    marginBottom: Spacing.L,
  },
  balanceLabel: {
    ...Typography.CAPTION,
    color: 'rgba(255,255,255,0.8)',
    marginBottom: Spacing.S,
  },
  balanceAmount: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 32,
    color: '#FFFFFF',
  },
  balanceErrorText: {
    ...Typography.BODY,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  balanceRetryText: {
    ...Typography.CAPTION,
    color: 'rgba(255,255,255,0.8)',
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
    backgroundColor: theme.border,
  },
  dividerText: {
    ...Typography.CAPTION,
    color: theme.inkMuted,
    marginHorizontal: Spacing.M,
  },
  sectionTitle: {
    ...Typography.SECTION_HEADING,
    color: theme.ink,
    marginBottom: Spacing.M,
  },
  cbnNotice: {
    ...Typography.CAPTION,
    color: theme.inkMuted,
    marginBottom: Spacing.L,
    lineHeight: 18,
  },
  paystackCheckText: {
    ...Typography.CAPTION,
    color: theme.brand,
    marginTop: -Spacing.M,
    marginBottom: Spacing.L,
    lineHeight: 18,
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
    borderColor: theme.border,
    alignItems: 'center',
    backgroundColor: theme.surface,
  },
  quickAmountSelected: {
    backgroundColor: theme.brandSoft,
    borderColor: theme.brand,
  },
  quickAmountText: {
    ...Typography.BODY,
    fontWeight: '600',
    color: theme.ink,
  },
  quickAmountTextSelected: {
    color: theme.brand,
  },
  currencySymbol: {
    ...Typography.BODY,
    color: theme.inkMuted,
    marginRight: Spacing.S,
  },
  fundButton: {
    backgroundColor: theme.brand,
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
    color: '#FFFFFF',
  },
  });
}

export default WalletFundingScreen;
