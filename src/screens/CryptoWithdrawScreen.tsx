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
  isValidCryptoAddress,
  CRYPTO_NETWORKS,
  WITHDRAW_SINGLE_NETWORK_ASSETS,
  type CryptoAsset,
  type CryptoNetwork,
  type SavedCryptoAddress,
  type CryptoWithdrawQuote,
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

// Same names crypto-markets (the Buy coin list) uses server-side —
// SUPPORTED_SWAP_ASSETS in supabase/functions/_shared/crypto-assets.ts.
const ASSET_NAMES: Record<CryptoAsset, string> = {
  USDT: 'Tether',
  BTC: 'Bitcoin',
  ETH: 'Ethereum',
  SOL: 'Solana',
  TRX: 'Tron',
  LTC: 'Litecoin',
  DOGE: 'Dogecoin',
  ADA: 'Cardano',
};
const WITHDRAWABLE_ASSETS = ['USDT', ...WITHDRAW_SINGLE_NETWORK_ASSETS] as CryptoAsset[];

/**
 * Withdraw as its own 3-step screen (asset -> address -> amount), matching
 * the same own-screen navigation pattern Buy and Sell already use. Unlike
 * Buy, a withdrawal has no follow-up payment-instructions step -- the
 * confirm here is terminal, so this screen owns its own result view rather
 * than handing off to CryptoScreen (same as CryptoSellBankScreen). Owner
 * decision, 2026-09-04.
 */
export default function CryptoWithdrawScreen({ navigation }: { navigation: any }) {
  const { authorize } = useTransactionAuth();
  const { theme } = useTheme();
  const styles = createStyles(theme);

  // Reached straight from Home's action row now, not via CryptoScreen's own
  // tab gate — so this screen needs its own service-enabled check rather
  // than trusting a caller that no longer runs it first. Withdraw doesn't
  // require KYC (only Buy/Sell do), matching CryptoScreen's existing gate.
  const [serviceEnabled, setServiceEnabled] = useState(true);
  useFocusEffect(
    useCallback(() => {
      cryptoService.isEnabled().then(setServiceEnabled).catch(() => {});
    }, []),
  );

  const [step, setStep] = useState<'asset' | 'address' | 'amount'>('asset');
  const [wdAsset, setWdAsset] = useState<CryptoAsset>('USDT');
  const [wdNetwork, setWdNetwork] = useState<CryptoNetwork>('TRC20');
  const [wdAddress, setWdAddress] = useState('');
  const [wdAmount, setWdAmount] = useState('');
  const [wdVerified, setWdVerified] = useState(false);
  const [wdSending, setWdSending] = useState(false);
  const [savedAddresses, setSavedAddresses] = useState<SavedCryptoAddress[]>([]);
  const [wdQuote, setWdQuote] = useState<CryptoWithdrawQuote | null>(null);
  const [wdQuoteLoading, setWdQuoteLoading] = useState(false);
  const [wdQuoteError, setWdQuoteError] = useState<string | null>(null);
  // Fetched once, for every asset -- the picker step shows each coin's own
  // balance so the customer can see what's actually worth withdrawing
  // before committing to one, not just after.
  const [quidaxWallets, setQuidaxWallets] = useState<QuidaxWalletBalance[]>([]);

  const [actionState, setActionState] = useState<ResultStatus | 'idle'>('idle');
  const [actionError, setActionError] = useState('');
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  useEffect(() => {
    cryptoService.getOrCreateAccount().then((account) => {
      if (account.success) setQuidaxWallets(account.wallets);
    });
  }, []);

  const balanceOf = useCallback(
    (asset: CryptoAsset): number | null => {
      const wallet = quidaxWallets.find((w) => w.currency === asset);
      return wallet ? Number(wallet.balance) : null;
    },
    [quidaxWallets],
  );
  const wdBalance = balanceOf(wdAsset);

  useEffect(() => {
    cryptoService.listSavedAddresses('USDT').then(setSavedAddresses);
  }, []);

  // loadAll only ever fetches USDT's saved addresses (the default asset on
  // mount) — this covers every other asset the picker switches to.
  useEffect(() => {
    if (wdAsset === 'USDT') return;
    let cancelled = false;
    cryptoService.listSavedAddresses(wdAsset).then((list) => {
      if (!cancelled) setSavedAddresses(list);
    });
    return () => { cancelled = true; };
  }, [wdAsset]);

  // Any edit to the withdrawal address/network invalidates the "I've
  // checked this" confirmation — never let a stale confirmation carry over
  // to a different address, same discipline as the meter-verify flow.
  useEffect(() => {
    setWdVerified(false);
  }, [wdAddress, wdNetwork, wdAsset]);

  const numericWdAmount = parseFloat(wdAmount);

  // Same purpose as Sell's own quote effect: show the real network fee
  // before confirming, not after. Re-fetches on network/asset change too —
  // TRC20/ERC20 differ from BEP20 by two orders of magnitude for the
  // identical send. No client-side amount floor/ceiling here beyond
  // "greater than zero" — the real min/max is asset-specific and comes
  // back live in the quote itself.
  useEffect(() => {
    setWdQuote(null);
    setWdQuoteError(null);
    if (!Number.isFinite(numericWdAmount) || numericWdAmount <= 0) {
      setWdQuoteLoading(false);
      return;
    }
    let cancelled = false;
    const handle = setTimeout(async () => {
      setWdQuoteLoading(true);
      const result = await cryptoService.getWithdrawQuote(wdAsset, wdAsset === 'USDT' ? wdNetwork : '', numericWdAmount);
      if (cancelled) return;
      setWdQuoteLoading(false);
      if (result.success && result.quote) setWdQuote(result.quote);
      else setWdQuoteError(result.error || 'Could not calculate the live network fee.');
    }, 400);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [numericWdAmount, wdAsset, wdNetwork]);

  const wdAddressValid = wdAddress.trim().length > 0 && isValidCryptoAddress(wdAsset, wdAsset === 'USDT' ? wdNetwork : '', wdAddress);
  const wdAddressError = wdAddress.trim().length > 0 && !wdAddressValid
    ? `This doesn't look like a valid ${wdAsset === 'USDT' ? wdNetwork : wdAsset} address.`
    : null;

  // Requires a live quote confirming both that the balance actually covers
  // amount + fee (not just amount) and that the amount clears this
  // asset/network's real minimum and maximum — both computed live per
  // asset, never a flat USDT-shaped number (5 BTC would be absurd).
  const canWithdraw = Number.isFinite(numericWdAmount) && numericWdAmount > 0
    && wdBalance != null && wdAddressValid && wdVerified
    && wdQuote?.sufficient === true && numericWdAmount >= wdQuote.minForNetwork
    && numericWdAmount <= wdQuote.maxLimit;

  const submitWithdraw = useCallback(async () => {
    const wdNetworkForRequest = wdAsset === 'USDT' ? wdNetwork : '';
    const authResult = await authorize({
      title: 'Confirm Crypto Withdrawal',
      subtitle: `${numericWdAmount} ${wdAsset} · ${wdAsset === 'USDT' ? wdNetwork : wdAsset} · ${wdAddress.trim()}`,
    });
    if (!authResult) {
      setWdSending(false);
      return;
    }
    setActionState('processing');
    const result = await cryptoService.withdraw(wdAsset, wdNetworkForRequest, wdAddress, numericWdAmount, authResult.token);
    setWdSending(false);
    if (result.success) {
      setActionMessage(result.message ?? null);
      setActionState('success');
      await cryptoService.saveAddress(wdAsset, wdNetworkForRequest, wdAddress, '');
      setWdAddress('');
      setWdAmount('');
      setWdVerified(false);
    } else {
      setActionError(result.error || 'Withdrawal failed. Please try again.');
      setActionState('failed');
    }
  }, [numericWdAmount, wdAsset, wdNetwork, wdAddress, authorize]);

  const handleWithdraw = useCallback(() => {
    if (!canWithdraw || wdSending) return;
    // Disabled BEFORE the PIN/biometric step, not after it — authorize()
    // awaits real user interaction, so leaving the button live until it
    // resolves lets a second tap fire a second, separate withdrawal. Same
    // ordering already fixed for Sell and used by Buy.
    setWdSending(true);
    submitWithdraw();
  }, [canWithdraw, wdSending, submitWithdraw]);

  const handlePickWdAsset = useCallback((next: CryptoAsset) => {
    setWdAsset(next);
    setWdAddress('');
    setWdAmount('');
    setWdVerified(false);
    setStep('address');
  }, []);

  const handlePickSaved = useCallback((addr: SavedCryptoAddress) => {
    setWdAsset(addr.asset);
    if (addr.asset === 'USDT' && addr.network) setWdNetwork(addr.network as CryptoNetwork);
    setWdAddress(addr.address);
    setWdVerified(false);
    cryptoService.touchAddress(addr.id);
    // Address is already known-good (a previously saved one) -- skip
    // straight to amount rather than making the customer re-confirm a
    // field they didn't just type.
    setStep('amount');
  }, []);

  if (actionState !== 'idle') {
    return (
      <ResultStatusView
        status={actionState}
        headerTitle="Withdraw Crypto"
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
          <Text style={styles.headerTitle}>Withdraw Crypto</Text>
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
        <Text style={styles.headerTitle}>Withdraw Crypto</Text>
        <View style={{ width: 24 }} />
      </View>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Text style={styles.notLiveBanner}>
            Sends crypto held in your KaysPay Wallet to any external wallet. Network fees are deducted by the
            network itself.
          </Text>

          {step === 'asset' && (
            <>
              <Text style={styles.label}>What are you withdrawing?</Text>
              <Text style={styles.hintText}>Tap a coin to continue.</Text>
              <View style={styles.assetList}>
                {WITHDRAWABLE_ASSETS.map((a) => {
                  const balance = balanceOf(a);
                  return (
                    <TouchableOpacity
                      key={a}
                      style={styles.assetRow}
                      onPress={() => handlePickWdAsset(a)}
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

              {savedAddresses.length > 0 && (
                <>
                  <Text style={styles.label}>Saved addresses</Text>
                  {savedAddresses.map((a) => (
                    <TouchableOpacity key={a.id} style={styles.savedRow} onPress={() => handlePickSaved(a)}>
                      <Text style={styles.savedRowText} numberOfLines={1}>
                        {a.label ? `${a.label} · ` : ''}{a.address.slice(0, 6)}...{a.address.slice(-4)} ({a.asset === 'USDT' ? a.network : a.asset})
                      </Text>
                    </TouchableOpacity>
                  ))}
                </>
              )}
            </>
          )}

          {step === 'address' && (
            <>
              <TouchableOpacity style={styles.backLink} onPress={() => setStep('asset')}>
                <Ionicons name="chevron-back" size={16} color={theme.inkFaint} />
                <Text style={styles.backLinkText}>Change asset</Text>
              </TouchableOpacity>

              <View style={styles.coinSummaryRow}>
                <ProviderLogo
                  source={CRYPTO_LOGOS[wdAsset]}
                  fallbackLabel={wdAsset}
                  fallbackColor={theme.brand}
                  size={38}
                  style={{ marginRight: Spacing.M }}
                />
                <Text style={styles.coinName}>Withdrawing {wdAsset}</Text>
              </View>

              {wdAsset === 'USDT' && (
                <>
                  <Text style={styles.label}>Network</Text>
                  <View style={styles.networkRow}>
                    {CRYPTO_NETWORKS.map((n) => (
                      <TouchableOpacity
                        key={n.key}
                        style={[styles.networkChip, wdNetwork === n.key && styles.networkChipSelected]}
                        onPress={() => setWdNetwork(n.key)}
                      >
                        <Text style={[styles.networkChipText, wdNetwork === n.key && styles.networkChipTextSelected]}>
                          {n.label}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </>
              )}

              <Text style={styles.label}>Wallet Address</Text>
              <TextInput
                style={styles.input}
                value={wdAddress}
                onChangeText={setWdAddress}
                placeholder={`Paste your ${wdAsset === 'USDT' ? wdNetwork : wdAsset} address`}
                placeholderTextColor={theme.inkFaint}
                autoCapitalize="none"
                autoCorrect={false}
              />
              {/* Format/checksum validation only — the strongest real
                  check possible. There is no registry to confirm a
                  crypto address belongs to an actual wallet, unlike a
                  bank account number. */}
              {wdAddressError && <Text style={styles.errorText}>{wdAddressError}</Text>}
              {wdAddressValid && (
                <View style={styles.checkRow}>
                  <Ionicons name="checkmark-circle" size={16} color={theme.brand} />
                  <Text style={[styles.checkLabel, { color: theme.brand }]}>
                    Looks like a valid {wdAsset === 'USDT' ? wdNetwork : wdAsset} address
                  </Text>
                </View>
              )}

              <TouchableOpacity
                style={[styles.primaryButton, !wdAddressValid && styles.primaryButtonDisabled]}
                onPress={() => setStep('amount')}
                disabled={!wdAddressValid}
              >
                <Text style={styles.primaryButtonText}>Continue</Text>
              </TouchableOpacity>
            </>
          )}

          {step === 'amount' && (
            <>
              <TouchableOpacity style={styles.backLink} onPress={() => setStep('address')}>
                <Ionicons name="chevron-back" size={16} color={theme.inkFaint} />
                <Text style={styles.backLinkText}>Change address</Text>
              </TouchableOpacity>

              <View style={styles.coinSummaryRow}>
                <ProviderLogo
                  source={CRYPTO_LOGOS[wdAsset]}
                  fallbackLabel={wdAsset}
                  fallbackColor={theme.brand}
                  size={38}
                  style={{ marginRight: Spacing.M }}
                />
                <Text style={styles.coinName} numberOfLines={1}>
                  {wdAsset === 'USDT' ? wdNetwork : wdAsset} · {wdAddress.trim().slice(0, 6)}...{wdAddress.trim().slice(-4)}
                </Text>
              </View>

              <Text style={styles.label}>Amount ({wdAsset})</Text>
              <TextInput
                style={styles.input}
                value={wdAmount}
                onChangeText={(t) => setWdAmount(t.replace(/[^0-9.]/g, ''))}
                placeholder={wdAsset === 'USDT' ? 'e.g. 20' : 'e.g. 0.001'}
                placeholderTextColor={theme.inkFaint}
                keyboardType="decimal-pad"
              />
              {wdBalance != null && numericWdAmount > wdBalance && (
                <Text style={styles.errorText}>Insufficient {wdAsset} balance.</Text>
              )}

              {/* Shows the real per-network fee before confirming — the
                  withdraw screen used to show none at all, on any network,
                  for any amount. A 5 USDT withdrawal on ERC20 cost $2 in
                  fees with nothing on screen ever warning it was coming. */}
              {wdQuote && (
                <View style={styles.wdQuoteCard}>
                  <Text style={styles.wdQuoteText}>Amount to withdraw: {formatCoin(wdQuote.amount, wdAsset)}</Text>
                  <Text style={styles.wdQuoteText}>
                    {wdQuote.network} network fee: {formatCoin(wdQuote.networkFee, wdAsset)}
                    {wdQuote.feeSharePercent != null ? ` (${wdQuote.feeSharePercent}%)` : ''}
                  </Text>
                  <Text style={styles.wdQuoteTotal}>Total required: {formatCoin(wdQuote.totalRequired, wdAsset)}</Text>
                </View>
              )}
              {wdQuote && !wdQuote.sufficient && (
                <Text style={styles.errorText}>
                  You need {formatCoin(wdQuote.totalRequired, wdAsset)}, but only {formatCoin(wdQuote.available, wdAsset)} is available.
                </Text>
              )}
              {wdQuote && numericWdAmount > 0 && numericWdAmount < wdQuote.minForNetwork && (
                <Text style={styles.errorText}>
                  Enter at least {formatCoin(wdQuote.minForNetwork, wdAsset)} for {wdQuote.network} — the network fee makes anything smaller not worth sending.
                </Text>
              )}
              {wdQuote && numericWdAmount > wdQuote.maxLimit && (
                <Text style={styles.errorText}>
                  Enter an amount up to {formatCoin(wdQuote.maxLimit, wdAsset)}.
                </Text>
              )}
              {wdQuoteError && <Text style={styles.errorText}>{wdQuoteError}</Text>}

              {wdAddressValid && numericWdAmount > 0 && (
                <View style={styles.confirmBox}>
                  <Text style={styles.confirmText}>
                    Sending {Number.isFinite(numericWdAmount) ? numericWdAmount : 0} {wdAsset} on {wdAsset === 'USDT' ? wdNetwork : wdAsset} to{'\n'}
                    {wdAddress.trim()}
                  </Text>
                  <Text style={styles.confirmWarning}>
                    This cannot be reversed if the address or network is wrong. Only send to a wallet you control.
                  </Text>
                  <TouchableOpacity style={styles.checkRow} onPress={() => setWdVerified((v) => !v)}>
                    <View style={[styles.checkbox, wdVerified && styles.checkboxChecked]}>
                      {wdVerified && <Text style={styles.checkboxMark}>✓</Text>}
                    </View>
                    <Text style={styles.checkLabel}>I've checked this address and network are correct</Text>
                  </TouchableOpacity>
                </View>
              )}

              <TouchableOpacity
                style={[styles.primaryButton, (!canWithdraw || wdSending) && styles.primaryButtonDisabled]}
                onPress={handleWithdraw}
                disabled={!canWithdraw || wdSending}
              >
                {wdSending ? (
                  <ActivityIndicator color={theme.background} />
                ) : (
                  <Text style={styles.primaryButtonText}>Withdraw {wdAsset}</Text>
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

    savedRow: {
      borderWidth: 1,
      borderColor: theme.hairline,
      backgroundColor: theme.surfaceRaised,
      borderRadius: Spacing.CARD_RADIUS,
      padding: Spacing.M,
      marginBottom: Spacing.S,
    },
    savedRowText: { ...Typography.BODY, color: theme.ink },

    networkRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.S },
    networkChip: {
      paddingHorizontal: Spacing.M,
      paddingVertical: Spacing.S,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: theme.hairline,
    },
    networkChipSelected: { backgroundColor: theme.brandSoft, borderColor: theme.brand },
    networkChipText: { ...Typography.CAPTION, color: theme.inkMuted, fontWeight: '600' },
    networkChipTextSelected: { color: theme.brand },

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

    checkRow: { flexDirection: 'row', alignItems: 'center', marginTop: Spacing.M },
    checkbox: {
      width: 22,
      height: 22,
      borderRadius: 6,
      borderWidth: 2,
      borderColor: theme.brand,
      justifyContent: 'center',
      alignItems: 'center',
      marginRight: Spacing.M,
    },
    checkboxChecked: { backgroundColor: theme.brand },
    checkboxMark: { color: theme.background, fontSize: 14, fontWeight: '700' },
    checkLabel: { ...Typography.CAPTION, color: theme.ink, flex: 1 },

    wdQuoteCard: { marginTop: Spacing.S, padding: Spacing.M, borderRadius: 12, backgroundColor: theme.surfaceRaised },
    wdQuoteText: { ...Typography.BODY_SMALL, color: theme.inkMuted, marginBottom: 4 },
    wdQuoteTotal: { ...Typography.BODY, color: theme.ink, fontWeight: '700' },

    confirmBox: {
      backgroundColor: theme.surfaceRaised,
      borderWidth: 1,
      borderColor: theme.hairline,
      borderRadius: Spacing.CARD_RADIUS,
      padding: Spacing.CARD_PADDING,
      marginTop: Spacing.L,
    },
    confirmText: { ...Typography.BODY, color: theme.ink },
    confirmWarning: { ...Typography.CAPTION, color: theme.gold, marginTop: Spacing.S },

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
