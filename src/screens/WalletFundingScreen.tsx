import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  Keyboard,
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
import { kycService } from '../services/kyc.service';
import ProviderFundingBlock from '../components/ProviderFundingBlock';
import { supabase } from '../lib/supabase';
import { useCachedData } from '../hooks/useCachedData';
import { Ionicons } from '@expo/vector-icons';
import { analytics } from '../services/analytics.service';
import { useSensitiveScreenProtection } from '../hooks/useSensitiveScreenProtection';

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
  useSensitiveScreenProtection();
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
  const initialObservedBalanceRef = useRef<number | null>(null);

  useFocusEffect(
    useCallback(() => {
      void analytics.track('funding_viewed', { outcome: 'view', metadata: { entry_point: 'wallet_funding' } });
    }, []),
  );

  useEffect(() => {
    paystackCheckStatusRef.current = paystackCheckStatus;
  }, [paystackCheckStatus]);

  // Bank-transfer funding requires a verified identity (CBN requires BVN/NIN
  // to issue a dedicated account number, and this reuses the app's own
  // verified-NIN flow instead of the old raw, unverified entry). null =
  // not checked yet, so the gate/funding UI never flashes the wrong state.
  // Re-checked on every focus so returning from KYC unlocks this immediately.
  const [kycVerified, setKycVerified] = useState<boolean | null>(null);
  const [verifiedNin, setVerifiedNin] = useState<string | undefined>();

  useFocusEffect(
    useCallback(() => {
      kycService.getStatus().then((s) => {
        // A failed check (network blip) is not the same as a confirmed
        // "not verified" — once we've genuinely seen verified === true,
        // don't let a later timeout slam the gate shut on this account.
        setKycVerified((prev) => (s.checkFailed && prev === true ? true : s.verified));
        if (!s.checkFailed) setVerifiedNin(s.verifiedNin);
      });
    }, []),
  );
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
    const current = realtimeBalance ?? balance;
    if (current !== null && initialObservedBalanceRef.current === null) initialObservedBalanceRef.current = current;
  }, [balance, realtimeBalance]);

  // Same last-known-good caching as the balance above — these account
  // numbers essentially never change once issued, so showing yesterday's
  // cached value instantly while a fresh check runs in the background is
  // always correct, unlike a balance which can genuinely go stale.
  const fetchAccountsOrThrow = useCallback(async () => {
    if (!BANK_TRANSFER_FUNDING_ENABLED) {
      return { flutterwave: null, paystack: null } as Record<VirtualAccountProvider, VirtualAccount | null>;
    }
    return virtualAccountService.getAllMine();
  }, []);
  const {
    data: cachedAccounts,
    loading: accountsInitialLoading,
    refresh: refreshAccounts,
  } = useCachedData('virtual_accounts', fetchAccountsOrThrow);
  const accounts = cachedAccounts ?? { flutterwave: null, paystack: null };

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
        if (initialObservedBalanceRef.current === 0 && newBalance > 0) {
          initialObservedBalanceRef.current = newBalance;
          void analytics.track('first_funding_completed', { outcome: 'completed', metadata: { funding_method: 'bank_transfer' } });
        }
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
      <View style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity
            style={styles.backButton}
            onPress={() => { Keyboard.dismiss(); navigation.goBack(); }}
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

            <Text style={styles.walletPurposeHint}>
              For airtime, data, bills and transfers. Crypto is paid by direct bank transfer.
            </Text>

            <View style={styles.cryptoNudge}>
              <View style={styles.cryptoNudgeCopy}>
                {/* The point used to sit mid-sentence in a grey-toned line
                    and got skimmed. Someone here to buy crypto would fund
                    this wallet, wait, and find the money was never used for
                    it. The heading now states the action first, the body
                    says plainly that funding here will not pay for crypto,
                    and the way out is a real button rather than a text
                    link. Shown to everyone now (owner decision, 2026-09-04),
                    not just people who just visited the Crypto screen. */}
                <View style={styles.cryptoNudgeHeading}>
                  <Ionicons name="arrow-forward-circle-outline" size={18} color={theme.gold} />
                  <Text style={styles.cryptoNudgeTitle}>Buying crypto? Skip this step</Text>
                </View>
                <Text style={styles.cryptoNudgeText}>
                  You pay for crypto by bank transfer to an account we show you — not from this
                  wallet. Funding here won't be used for it.
                </Text>
                <TouchableOpacity
                  onPress={() => navigation.navigate('Crypto')}
                  activeOpacity={0.85}
                  style={styles.cryptoNudgeButton}
                >
                  <Text style={styles.cryptoNudgeButtonText}>Take me back to Crypto</Text>
                </TouchableOpacity>
              </View>
            </View>

            {BANK_TRANSFER_FUNDING_ENABLED && (
              <>
                <Text style={styles.sectionTitle}>Fund by Bank Transfer</Text>
                {kycVerified === false ? (
                  <View style={styles.kycGate}>
                    <View style={styles.kycGateIconWrap}>
                      <Ionicons name="shield-checkmark-outline" size={28} color={theme.brand} />
                    </View>
                    <Text style={styles.kycGateTitle}>Verify Your Identity</Text>
                    <Text style={styles.kycGateSubtitle}>
                      Nigerian banking regulation (CBN) requires a verified BVN or NIN to issue a
                      dedicated account number. Verify your identity to set up bank transfer funding —
                      it only takes a minute.
                    </Text>
                    <TouchableOpacity
                      style={styles.kycGateButton}
                      onPress={() => navigation.navigate('Kyc', { requiredFor: 'fund your wallet' })}
                      activeOpacity={0.85}
                    >
                      <Text style={styles.kycGateButtonText}>Verify Now</Text>
                    </TouchableOpacity>
                  </View>
                ) : (
                  <>
                    <Text style={styles.cbnNotice}>
                      Nigerian banking regulation (CBN) requires a BVN or NIN to issue any dedicated
                      account number. Your verified identity is reused automatically — nothing more to enter.
                    </Text>
                    <ProviderFundingBlock
                      provider="flutterwave"
                      providerLabel="Flutterwave"
                      account={accounts.flutterwave}
                      initialLoading={accountsInitialLoading}
                      verifiedNin={verifiedNin}
                      onCreated={() => refreshAccounts()}
                    />
                    {PAYSTACK_FUNDING_ENABLED && (
                      <ProviderFundingBlock
                        provider="paystack"
                        providerLabel="Paystack"
                        account={accounts.paystack}
                        initialLoading={accountsInitialLoading}
                        verifiedNin={verifiedNin}
                        onCreated={() => refreshAccounts()}
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
              </>
            )}
        </ScrollView>
      </View>
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
  walletPurposeHint: {
    ...Typography.CAPTION,
    color: theme.inkMuted,
    marginTop: Spacing.S,
    marginBottom: Spacing.L,
    lineHeight: 17,
  },
  cryptoNudge: {
    flexDirection: 'row',
    gap: Spacing.S,
    backgroundColor: `${theme.gold}1A`,
    borderRadius: Spacing.CARD_RADIUS,
    padding: Spacing.M,
    marginBottom: Spacing.L,
  },
  cryptoNudgeCopy: { flex: 1 },
  cryptoNudgeHeading: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    marginBottom: 6,
  },
  cryptoNudgeTitle: {
    ...Typography.CAPTION,
    fontWeight: '700',
    color: theme.ink,
  },
  cryptoNudgeButton: {
    alignSelf: 'flex-start',
    backgroundColor: theme.brand,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 7,
    marginTop: 10,
  },
  cryptoNudgeButtonText: {
    ...Typography.CAPTION,
    fontWeight: '700',
    color: theme.onBrand,
  },
  cryptoNudgeText: {
    ...Typography.CAPTION,
    color: theme.ink,
    lineHeight: 18,
  },
  cbnNotice: {
    ...Typography.CAPTION,
    color: theme.inkMuted,
    marginBottom: Spacing.L,
    lineHeight: 18,
  },
  kycGate: {
    alignItems: 'center',
    backgroundColor: theme.surfaceRaised,
    borderRadius: 12,
    paddingVertical: Spacing.XL,
    paddingHorizontal: Spacing.M,
    marginBottom: Spacing.L,
  },
  kycGateIconWrap: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: theme.brandSoft,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: Spacing.M,
  },
  kycGateTitle: { ...Typography.CARD_TITLE, color: theme.ink, marginBottom: Spacing.S },
  kycGateSubtitle: {
    ...Typography.BODY,
    color: theme.inkMuted,
    textAlign: 'center',
    marginBottom: Spacing.L,
  },
  kycGateButton: {
    height: Spacing.BUTTON_HEIGHT_PRIMARY,
    minWidth: 160,
    backgroundColor: theme.brand,
    borderRadius: Spacing.BUTTON_RADIUS,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: Spacing.L,
  },
  kycGateButtonText: { ...Typography.BUTTON_TEXT, color: theme.background },
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
