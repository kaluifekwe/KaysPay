import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  StyleSheet,
  Text,
  ScrollView,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  Platform,
  StatusBar,
  KeyboardAvoidingView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { Typography } from '../constants/typography';
import { Spacing } from '../constants/spacing';
import { AppTheme } from '../constants/theme';
import { useTheme } from '../components/ThemeProvider';
import {
  cryptoService,
  type BuyAsset,
  type CryptoSwapQuote,
  type QuidaxWalletBalance,
} from '../services/crypto.service';
import { useTransactionAuth } from '../components/TransactionAuthProvider';
import ProviderLogo from '../components/ProviderLogo';
import { CRYPTO_LOGOS } from '../utils/providerLogos';
import ResultStatusView, { type ResultStatus } from '../components/ResultStatusView';

// How many decimals to show for a given coin — copied verbatim from
// CryptoScreen.tsx, which still has other users (the wallet-hero asset list).
function cryptoDecimals(n: number, code: string): number {
  if (code.toUpperCase() === 'USDT') return 2;
  const magnitude = Math.abs(n);
  if (magnitude >= 1) return 4;
  if (magnitude >= 0.01) return 6;
  return 8;
}

function formatCoinAmount(n: number, code: string): string {
  const dp = cryptoDecimals(n, code);
  const factor = 10 ** dp;
  const floored = Math.floor((Number.isFinite(n) ? n : 0) * factor) / factor;
  return floored.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

function formatCoin(n: number, code: string): string {
  return `${formatCoinAmount(n, code)} ${code}`;
}

// All 9 coins Swap supports, either direction — the same set Buy's own
// SUPPORTED_SWAP_ASSETS + USDT already prove out live (Buy's leg 2 already
// swaps USDT -> every one of these; Sell's leg 1 already swaps every one of
// these -> USDT). Includes XRP, unlike Withdraw -- Swap never touches an
// external address or a destination tag, so the risk that excludes XRP from
// Withdraw doesn't apply here. Owner decision, 2026-09-05.
const ALL_SWAP_ASSETS: BuyAsset[] = ['USDT', 'BTC', 'ETH', 'SOL', 'XRP', 'TRX', 'LTC', 'DOGE', 'ADA'];
const ASSET_NAMES: Record<BuyAsset, string> = {
  USDT: 'Tether',
  BTC: 'Bitcoin',
  ETH: 'Ethereum',
  SOL: 'Solana',
  XRP: 'Ripple',
  TRX: 'Tron',
  LTC: 'Litecoin',
  DOGE: 'Dogecoin',
  ADA: 'Cardano',
};

/**
 * Swap as its own 3-step screen (from -> to -> amount), matching the same
 * own-screen navigation pattern Buy/Withdraw already use. No bank/off-ramp
 * step at all -- the destination coin lands straight back in the same
 * Quidax sub-account, so the confirm here is terminal, same as Withdraw.
 */
export default function CryptoSwapScreen({ navigation }: { navigation: any }) {
  const { authorize } = useTransactionAuth();
  const { theme } = useTheme();
  const styles = createStyles(theme);

  const [serviceEnabled, setServiceEnabled] = useState(true);
  useFocusEffect(
    useCallback(() => {
      cryptoService.isEnabled().then(setServiceEnabled).catch(() => {});
    }, []),
  );

  const [step, setStep] = useState<'from' | 'to' | 'amount'>('from');
  const [fromAsset, setFromAsset] = useState<BuyAsset>('USDT');
  const [toAsset, setToAsset] = useState<BuyAsset>('BTC');
  const [amount, setAmount] = useState('');
  const [sending, setSending] = useState(false);
  const [quidaxWallets, setQuidaxWallets] = useState<QuidaxWalletBalance[]>([]);
  const [quote, setQuote] = useState<CryptoSwapQuote | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);

  const [actionState, setActionState] = useState<ResultStatus | 'idle'>('idle');
  const [actionError, setActionError] = useState('');
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  useEffect(() => {
    cryptoService.getOrCreateAccount().then((account) => {
      if (account.success) setQuidaxWallets(account.wallets);
    });
  }, []);

  const balanceOf = useCallback(
    (asset: BuyAsset): number | null => {
      const wallet = quidaxWallets.find((w) => w.currency === asset);
      return wallet ? Number(wallet.balance) : null;
    },
    [quidaxWallets],
  );
  const fromBalance = balanceOf(fromAsset);

  const numericAmount = parseFloat(amount);

  // Same purpose as Sell/Withdraw's own quote effect: show the real
  // estimate before confirming. Debounced 400ms, same as the others.
  useEffect(() => {
    setQuote(null);
    setQuoteError(null);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      setQuoteLoading(false);
      return;
    }
    let cancelled = false;
    const handle = setTimeout(async () => {
      setQuoteLoading(true);
      const result = await cryptoService.getSwapQuote(fromAsset, toAsset, numericAmount);
      if (cancelled) return;
      setQuoteLoading(false);
      if (result.success && result.quote) setQuote(result.quote);
      else setQuoteError(result.error || 'Could not price this swap.');
    }, 400);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [numericAmount, fromAsset, toAsset]);

  const canSwap = Number.isFinite(numericAmount) && numericAmount > 0
    && fromBalance != null && numericAmount <= fromBalance
    && quote?.sufficient === true && !quoteLoading && !quoteError;

  const submitSwap = useCallback(async () => {
    const authResult = await authorize({
      title: 'Confirm Swap',
      subtitle: `${numericAmount} ${fromAsset} → ${toAsset}`,
    });
    if (!authResult) {
      setSending(false);
      return;
    }
    setActionState('processing');
    const result = await cryptoService.swap(fromAsset, toAsset, numericAmount, authResult.token);
    setSending(false);
    if (result.success) {
      setActionMessage(result.message ?? null);
      setActionState('success');
      setAmount('');
    } else {
      setActionError(result.error || 'Swap failed. Please try again.');
      setActionState('failed');
    }
  }, [numericAmount, fromAsset, toAsset, authorize]);

  const handleSwap = useCallback(() => {
    if (!canSwap || sending) return;
    setSending(true);
    submitSwap();
  }, [canSwap, sending, submitSwap]);

  const handlePickFrom = useCallback((next: BuyAsset) => {
    setFromAsset(next);
    // Keep `to` valid -- it can never equal `from`.
    setToAsset((prevTo) => (prevTo === next ? ALL_SWAP_ASSETS.find((a) => a !== next) ?? prevTo : prevTo));
    setAmount('');
    setStep('to');
  }, []);

  const handlePickTo = useCallback((next: BuyAsset) => {
    setToAsset(next);
    setAmount('');
    setStep('amount');
  }, []);

  if (actionState !== 'idle') {
    return (
      <ResultStatusView
        status={actionState}
        headerTitle="Swap Crypto"
        message={actionState === 'failed' ? actionError : actionMessage ?? undefined}
        onDone={() => {
          setActionMessage(null);
          setActionState('idle');
        }}
      />
    );
  }

  if (!serviceEnabled) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <StatusBar barStyle={theme.mode === 'dark' ? 'light-content' : 'dark-content'} backgroundColor={theme.background} />
        <View style={styles.header}>
          <TouchableOpacity onPress={navigation.goBack} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Ionicons name="chevron-back" size={24} color={theme.ink} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Swap Crypto</Text>
          <View style={{ width: 24 }} />
        </View>
        <View style={styles.centerFill}>
          <Ionicons name="logo-bitcoin" size={40} color={theme.inkFaint} />
          <Text style={styles.centerTitle}>Crypto is currently unavailable</Text>
          <Text style={styles.centerSubtitle}>We'll let you know as soon as it's back.</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={navigation.goBack} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Ionicons name="chevron-back" size={24} color={theme.ink} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Swap Crypto</Text>
        <View style={{ width: 24 }} />
      </View>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Text style={styles.notLiveBanner}>
            Converts one coin you hold into another, right inside your KaysPay Wallet. No bank account needed.
          </Text>

          {step === 'from' && (
            <>
              <Text style={styles.label}>What are you swapping from?</Text>
              <Text style={styles.hintText}>Tap a coin to continue.</Text>
              <View style={styles.assetList}>
                {ALL_SWAP_ASSETS.map((a) => {
                  const balance = balanceOf(a);
                  return (
                    <TouchableOpacity
                      key={a}
                      style={styles.assetRow}
                      onPress={() => handlePickFrom(a)}
                      activeOpacity={0.7}
                    >
                      <ProviderLogo
                        source={CRYPTO_LOGOS[a]}
                        fallbackLabel={ASSET_NAMES[a]}
                        fallbackColor={theme.brand}
                        size={36}
                        style={{ marginRight: Spacing.M }}
                      />
                      <View style={{ flex: 1 }}>
                        <Text style={styles.coinName}>{ASSET_NAMES[a]}</Text>
                        <Text style={styles.assetRowSub}>
                          {a} · balance {balance != null ? formatCoinAmount(balance, a) : '—'}
                        </Text>
                      </View>
                      <Ionicons name="chevron-forward" size={18} color={theme.inkFaint} />
                    </TouchableOpacity>
                  );
                })}
              </View>
            </>
          )}

          {step === 'to' && (
            <>
              <TouchableOpacity style={styles.backLink} onPress={() => setStep('from')}>
                <Ionicons name="chevron-back" size={16} color={theme.inkFaint} />
                <Text style={styles.backLinkText}>Change coin</Text>
              </TouchableOpacity>

              <View style={styles.coinSummaryRow}>
                <ProviderLogo
                  source={CRYPTO_LOGOS[fromAsset]}
                  fallbackLabel={fromAsset}
                  fallbackColor={theme.brand}
                  size={38}
                  style={{ marginRight: Spacing.M }}
                />
                <Text style={styles.coinName}>Swapping from {fromAsset}</Text>
              </View>

              <Text style={styles.label}>Swap it to what?</Text>
              <View style={styles.assetList}>
                {ALL_SWAP_ASSETS.filter((a) => a !== fromAsset).map((a) => (
                  <TouchableOpacity
                    key={a}
                    style={styles.assetRow}
                    onPress={() => handlePickTo(a)}
                    activeOpacity={0.7}
                  >
                    <ProviderLogo
                      source={CRYPTO_LOGOS[a]}
                      fallbackLabel={ASSET_NAMES[a]}
                      fallbackColor={theme.brand}
                      size={36}
                      style={{ marginRight: Spacing.M }}
                    />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.coinName}>{ASSET_NAMES[a]}</Text>
                      <Text style={styles.assetRowSub}>{a}</Text>
                    </View>
                    <Ionicons name="chevron-forward" size={18} color={theme.inkFaint} />
                  </TouchableOpacity>
                ))}
              </View>
            </>
          )}

          {step === 'amount' && (
            <>
              <TouchableOpacity style={styles.backLink} onPress={() => setStep('to')}>
                <Ionicons name="chevron-back" size={16} color={theme.inkFaint} />
                <Text style={styles.backLinkText}>Change coin</Text>
              </TouchableOpacity>

              <View style={styles.coinSummaryRow}>
                <ProviderLogo
                  source={CRYPTO_LOGOS[fromAsset]}
                  fallbackLabel={fromAsset}
                  fallbackColor={theme.brand}
                  size={38}
                  style={{ marginRight: Spacing.M }}
                />
                <Text style={styles.coinName}>{fromAsset} → {toAsset}</Text>
              </View>

              <Text style={styles.label}>Amount ({fromAsset})</Text>
              <TextInput
                style={styles.input}
                value={amount}
                onChangeText={(t) => setAmount(t.replace(/[^0-9.]/g, ''))}
                placeholder={fromAsset === 'USDT' ? 'e.g. 20' : 'e.g. 0.001'}
                placeholderTextColor={theme.inkFaint}
                keyboardType="decimal-pad"
                autoFocus
              />
              {fromBalance != null && (
                <Text style={styles.hintText}>Balance: {formatCoin(fromBalance, fromAsset)}</Text>
              )}
              {fromBalance != null && numericAmount > fromBalance && (
                <Text style={styles.errorText}>Insufficient {fromAsset} balance.</Text>
              )}

              {quoteLoading && (
                <View style={styles.wdQuoteCard}>
                  <ActivityIndicator color={theme.brand} />
                </View>
              )}
              {quote && !quoteLoading && (
                <View style={styles.wdQuoteCard}>
                  <Text style={styles.wdQuoteText}>
                    You'll get about {quote.estimatedToAmount != null ? formatCoin(quote.estimatedToAmount, toAsset) : '—'}
                  </Text>
                </View>
              )}
              {quoteError && <Text style={styles.errorText}>{quoteError}</Text>}

              {numericAmount > 0 && quote?.sufficient && (
                <View style={styles.confirmBox}>
                  <Text style={styles.confirmText}>
                    Swapping {numericAmount} {fromAsset} for about{' '}
                    {quote.estimatedToAmount != null ? formatCoin(quote.estimatedToAmount, toAsset) : `${toAsset}`}
                  </Text>
                </View>
              )}

              <TouchableOpacity
                style={[styles.primaryButton, (!canSwap || sending) && styles.primaryButtonDisabled]}
                onPress={handleSwap}
                disabled={!canSwap || sending}
              >
                {sending ? (
                  <ActivityIndicator color={theme.background} />
                ) : (
                  <Text style={styles.primaryButtonText}>Swap {fromAsset} for {toAsset}</Text>
                )}
              </TouchableOpacity>
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.background },
    centerFill: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: Spacing.L },
    centerTitle: { ...Typography.CARD_TITLE, color: theme.ink, marginTop: Spacing.M, textAlign: 'center' },
    centerSubtitle: { ...Typography.BODY, color: theme.inkMuted, marginTop: Spacing.S, textAlign: 'center' },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: Spacing.SCREEN_PADDING,
      paddingVertical: Spacing.M,
      borderBottomWidth: 1,
      borderBottomColor: theme.hairline,
    },
    headerTitle: { ...Typography.SECTION_HEADING, color: theme.ink },
    content: { paddingHorizontal: Spacing.SCREEN_PADDING, paddingVertical: Spacing.M, paddingBottom: 60 },
    hintText: { ...Typography.CAPTION, color: theme.inkMuted, marginTop: Spacing.M },

    notLiveBanner: {
      ...Typography.CAPTION,
      color: theme.brand,
      backgroundColor: theme.brandSoft,
      borderRadius: Spacing.CARD_RADIUS,
      padding: Spacing.M,
      marginBottom: Spacing.L,
    },

    label: { ...Typography.SECTION_HEADING, color: theme.ink, marginTop: Spacing.M, marginBottom: Spacing.M },
    input: {
      height: Spacing.INPUT_HEIGHT,
      borderWidth: Spacing.INPUT_BORDER_WIDTH,
      borderColor: theme.hairline,
      backgroundColor: theme.surfaceRaised,
      borderRadius: Spacing.BUTTON_RADIUS,
      paddingHorizontal: Spacing.L,
      ...Typography.BODY,
      color: theme.ink,
    },
    errorText: { ...Typography.ERROR, color: theme.down, marginTop: Spacing.S },

    backLink: { flexDirection: 'row', alignItems: 'center', marginBottom: Spacing.M },
    backLinkText: { ...Typography.CAPTION, color: theme.inkFaint, marginLeft: 2 },

    coinSummaryRow: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.surfaceRaised,
      borderWidth: 1,
      borderColor: theme.hairline,
      borderRadius: Spacing.CARD_RADIUS,
      padding: Spacing.M,
      marginBottom: Spacing.L,
    },
    coinName: { ...Typography.BODY, color: theme.ink, fontWeight: '600' },

    assetList: { marginTop: Spacing.M },
    assetRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: Spacing.M,
      borderBottomWidth: 1,
      borderBottomColor: theme.hairlineSoft,
    },
    assetRowSub: { ...Typography.CAPTION, color: theme.inkFaint, marginTop: 2 },

    wdQuoteCard: { marginTop: Spacing.S, padding: Spacing.M, borderRadius: 12, backgroundColor: theme.surfaceRaised },
    wdQuoteText: { ...Typography.BODY_SMALL, color: theme.inkMuted, marginBottom: 4 },

    confirmBox: {
      backgroundColor: theme.surfaceRaised,
      borderWidth: 1,
      borderColor: theme.hairline,
      borderRadius: Spacing.CARD_RADIUS,
      padding: Spacing.CARD_PADDING,
      marginTop: Spacing.L,
    },
    confirmText: { ...Typography.BODY, color: theme.ink },

    primaryButton: {
      height: Spacing.BUTTON_HEIGHT_PRIMARY,
      backgroundColor: theme.brand,
      borderRadius: Spacing.BUTTON_RADIUS,
      justifyContent: 'center',
      alignItems: 'center',
      marginTop: Spacing.L,
    },
    primaryButtonDisabled: { opacity: 0.4 },
    primaryButtonText: { ...Typography.BUTTON_TEXT, color: theme.background },
  });
}
