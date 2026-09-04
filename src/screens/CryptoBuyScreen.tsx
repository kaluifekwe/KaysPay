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
import { formatNaira } from '../utils/formatCurrency';
import { storageHelpers, StorageKeys } from '../lib/mmkv';
import {
  cryptoService,
  isValidCryptoAddress,
  CRYPTO_NETWORKS,
  type CryptoNetwork,
  type BuyAsset,
  type MarketCoin,
} from '../services/crypto.service';
import { kycService } from '../services/kyc.service';
import { useTransactionAuth } from '../components/TransactionAuthProvider';
import ProviderLogo from '../components/ProviderLogo';
import { CRYPTO_LOGOS } from '../utils/providerLogos';
import { analytics } from '../services/analytics.service';
import ResultStatusView, { type ResultStatus } from '../components/ResultStatusView';

type CoinFilter = 'popular' | 'gainers' | 'all';
const POPULAR_BUY_CODES: BuyAsset[] = ['USDT', 'BTC', 'ETH', 'SOL', 'XRP'];
const MONO = Platform.select({ ios: 'Courier', android: 'monospace', default: 'monospace' });

// A tiny connected-line sparkline built from pure Views (no react-native-svg
// in this project). Copied verbatim from CryptoScreen.tsx, which still has
// the only other user (the wallet-hero asset list).
function Sparkline({ open, low, high, last, up, upColor, downColor }: {
  open: number | null; low: number | null; high: number | null; last: number;
  up: boolean; upColor: string; downColor: string;
}) {
  const w = 46;
  const h = 16;
  const pts = [open ?? last, low ?? last, ((low ?? last) + (high ?? last)) / 2, high ?? last, last]
    .filter((n): n is number => Number.isFinite(n));
  if (pts.length < 2) return <View style={{ width: w, height: h }} />;
  const max = Math.max(...pts);
  const min = Math.min(...pts);
  const span = max - min || 1;
  const coords = pts.map((p, i) => ({
    x: (i / (pts.length - 1)) * w,
    y: h - ((p - min) / span) * h,
  }));
  const color = up ? upColor : downColor;
  return (
    <View style={{ width: w, height: h }}>
      {coords.slice(0, -1).map((p, i) => {
        const next = coords[i + 1];
        const dx = next.x - p.x;
        const dy = next.y - p.y;
        const length = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const angle = Math.atan2(dy, dx);
        return (
          <View
            key={i}
            style={{
              position: 'absolute',
              left: p.x,
              top: p.y,
              width: length,
              height: 1.6,
              backgroundColor: color,
              transform: [{ translateY: -0.8 }, { rotate: `${angle}rad` }],
              transformOrigin: '0 50%',
            }}
          />
        );
      })}
    </View>
  );
}

/**
 * Step 1 of Buy: pick a coin, enter an amount, confirm. Step 2 (the bank
 * transfer instructions, then live progress tracking while the purchase
 * settles) still lives on CryptoScreen for now -- deliberately not moved
 * yet, since it carries a Realtime subscription and countdown/elapsed
 * timers that deserve their own careful pass rather than being rushed
 * along with this split. On success this screen hands off to CryptoScreen
 * via navigation params (see CryptoScreen's pendingBuyPayment param
 * effect), the same way CryptoSellBankScreen already hands its result back
 * for Sell. Owner decision, 2026-09-04.
 */
export default function CryptoBuyScreen({ navigation }: { navigation: any }) {
  const { authorize } = useTransactionAuth();
  const { theme } = useTheme();
  const styles = createStyles(theme);

  // Reached straight from Home's action row now, not via CryptoScreen's own
  // tab gate — so this screen needs its own KYC/service checks rather than
  // trusting a caller that no longer runs them first. Same defense-in-depth
  // reasoning CryptoScreen documents for its own serviceEnabled check.
  const [kycVerified, setKycVerified] = useState<boolean | null>(null);
  useFocusEffect(
    useCallback(() => {
      kycService.getStatus().then((s) => setKycVerified(s.verified)).catch(() => setKycVerified(false));
    }, []),
  );
  const [serviceEnabled, setServiceEnabled] = useState(true);
  useFocusEffect(
    useCallback(() => {
      cryptoService.isEnabled().then(setServiceEnabled).catch(() => {});
    }, []),
  );

  const [step, setStep] = useState<'pick' | 'amount'>('pick');
  const [markets, setMarkets] = useState<MarketCoin[]>([]);
  const [marketsLoading, setMarketsLoading] = useState(true);
  const [coinSearch, setCoinSearch] = useState('');
  const [coinFilter, setCoinFilter] = useState<CoinFilter>('popular');
  const [buyLimits, setBuyLimits] = useState<{ minNgn: number; maxNgn: number } | null>(null);

  const [selectedBuyAsset, setSelectedBuyAsset] = useState<BuyAsset | null>(null);
  const [buyNgn, setBuyNgn] = useState('');
  const [buyToExternal, setBuyToExternal] = useState(false);
  const [buyDestNetwork, setBuyDestNetwork] = useState<CryptoNetwork>('TRC20');
  const [buyDestAddress, setBuyDestAddress] = useState('');
  const [buyDestVerified, setBuyDestVerified] = useState(false);
  const [buyLoading, setBuyLoading] = useState(false);

  const [actionState, setActionState] = useState<ResultStatus | 'idle'>('idle');
  const [actionError, setActionError] = useState('');

  useEffect(() => {
    setBuyDestVerified(false);
  }, [buyDestAddress, buyDestNetwork]);

  const loadMarkets = useCallback(async () => {
    setMarketsLoading(true);
    const result = await cryptoService.getMarkets();
    setMarketsLoading(false);
    if (result) {
      setMarkets(result.coins);
      // Display-only: a real purchase always re-prices server-side, so a
      // stale cached price here can never cost anyone anything.
      storageHelpers.setObject(StorageKeys.CRYPTO_MARKETS_CACHE, result.coins);
    }
  }, []);

  useEffect(() => {
    // Paints the coin list instantly from the last live fetch (any screen
    // this session, or a prior visit) while the real live fetch below runs
    // in parallel — same "cache-first paint" CryptoScreen already uses for
    // wallet balances. Buy is now its own screen reached directly from
    // Home, so there's no longer a head start from an earlier mount
    // elsewhere; without this the coin list showed a blank spinner every
    // time until the live Quidax ticker fetch completed.
    storageHelpers.getObject<MarketCoin[]>(StorageKeys.CRYPTO_MARKETS_CACHE).then((cached) => {
      if (cached && cached.length > 0) setMarkets(cached);
    });
    loadMarkets();
    cryptoService.getBuyLimits().then((limits) => { if (limits) setBuyLimits(limits); });
  }, [loadMarkets]);

  const handlePickBuyAsset = useCallback((code: BuyAsset) => {
    setSelectedBuyAsset(code);
    setBuyNgn('');
    setBuyToExternal(false);
    setStep('amount');
  }, []);

  const selectedMarket = markets.find((m) => m.code === selectedBuyAsset) || null;
  const visibleMarkets = markets
    .filter((m) => {
      if (!coinSearch.trim()) return true;
      const q = coinSearch.trim().toLowerCase();
      return m.code.toLowerCase().includes(q) || m.name.toLowerCase().includes(q);
    })
    .filter((m) => {
      if (coinFilter === 'gainers') return (m.change24hPct ?? 0) > 0;
      if (coinFilter === 'popular') return POPULAR_BUY_CODES.includes(m.code);
      return true;
    })
    .sort((a, b) => (coinFilter === 'gainers' ? (b.change24hPct ?? 0) - (a.change24hPct ?? 0) : 0));

  const numericBuyNgn = parseFloat(buyNgn);
  const buyDestAddressValid = buyDestAddress.trim().length > 0 && isValidCryptoAddress('USDT', buyDestNetwork, buyDestAddress);
  const buyDestAddressError = buyDestAddress.trim().length > 0 && !buyDestAddressValid
    ? `This doesn't look like a valid ${buyDestNetwork} address.`
    : null;
  const buyBelowMin = buyLimits != null && numericBuyNgn > 0 && numericBuyNgn < buyLimits.minNgn;
  const buyAboveMax = buyLimits != null && numericBuyNgn > 0 && numericBuyNgn > buyLimits.maxNgn;
  const canBuy = !!selectedBuyAsset && Number.isFinite(numericBuyNgn) && numericBuyNgn > 0
    && !buyBelowMin && !buyAboveMax
    && (!buyToExternal || (buyDestAddressValid && buyDestVerified));

  const handleBuy = useCallback(async () => {
    if (!canBuy || !selectedBuyAsset || buyLoading) return;
    // Disabled BEFORE the PIN/biometric step, not after it -- same discipline
    // as every other purchase screen in this app.
    setBuyLoading(true);
    const subtitle = buyToExternal
      ? `To ${buyDestNetwork} wallet ${buyDestAddress.trim()}`
      : 'To your KaysPay Wallet';
    const authResult = await authorize({
      title: `Confirm ${selectedBuyAsset} Purchase`,
      amount: numericBuyNgn || undefined,
      subtitle,
      // Buy is paid by bank transfer straight to Quidax's one-time account
      // -- it never debits the KaysPay wallet -- so a wallet-balance check
      // here is comparing against the wrong number entirely.
      skipBalanceCheck: true,
    });
    if (!authResult) {
      setBuyLoading(false);
      return;
    }
    void analytics.track('crypto_buy_started', { outcome: 'started' });
    const result = await cryptoService.buy(
      selectedBuyAsset,
      numericBuyNgn,
      authResult.token,
      buyToExternal ? { network: buyDestNetwork, address: buyDestAddress.trim() } : undefined,
    );
    setBuyLoading(false);
    if (result.success && result.payment) {
      // Hand off to CryptoScreen, which still owns the payment-instructions
      // + live progress-tracking UI (see this file's top comment).
      navigation.navigate('Crypto', {
        pendingBuyPayment: {
          payment: result.payment,
          estimatedCrypto: result.estimatedCrypto ?? 0,
          destinationType: result.destinationType ?? 'kayspay_account',
          asset: result.asset ?? selectedBuyAsset,
          pendingSwap: !!result.pendingSwap,
          transactionId: result.transactionId ?? '',
          expiresAt: Date.now() + 30 * 60 * 1000,
        },
      });
    } else {
      void analytics.track('crypto_buy_failed', { outcome: 'failed', failureCode: 'purchase_rejected' });
      setActionError(result.error || 'Purchase failed. Please try again.');
      setActionState('failed');
    }
  }, [canBuy, selectedBuyAsset, buyLoading, numericBuyNgn, buyToExternal, buyDestNetwork, buyDestAddress, authorize, navigation]);

  if (actionState !== 'idle') {
    return (
      <ResultStatusView
        status={actionState}
        headerTitle="Buy Crypto"
        message={actionState === 'failed' ? actionError : undefined}
        onDone={() => setActionState('idle')}
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
          <Text style={styles.headerTitle}>Buy Crypto</Text>
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

  if (kycVerified === false) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <StatusBar barStyle={theme.mode === 'dark' ? 'light-content' : 'dark-content'} backgroundColor={theme.background} />
        <View style={styles.header}>
          <TouchableOpacity onPress={navigation.goBack} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Ionicons name="chevron-back" size={24} color={theme.ink} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Buy Crypto</Text>
          <View style={{ width: 24 }} />
        </View>
        <View style={styles.kycGate}>
          <View style={styles.kycGateIconWrap}>
            <Ionicons name="shield-checkmark-outline" size={28} color={theme.brand} />
          </View>
          <Text style={styles.kycGateTitle}>Verify Your Identity</Text>
          <Text style={styles.kycGateSubtitle}>
            Buying crypto requires identity verification. Verify your NIN or BVN to continue — it only takes a minute.
          </Text>
          <TouchableOpacity
            style={styles.primaryButton}
            onPress={() => navigation.navigate('Kyc', { requiredFor: 'buy crypto' })}
            activeOpacity={0.85}
          >
            <Text style={styles.primaryButtonText}>Verify Now</Text>
          </TouchableOpacity>
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
        <Text style={styles.headerTitle}>Buy Crypto</Text>
        <View style={{ width: 24 }} />
      </View>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {step === 'pick' && (
            <View>
              <View style={styles.search}>
                <Ionicons name="search" size={15} color={theme.inkFaint} />
                <TextInput
                  style={styles.searchInput}
                  value={coinSearch}
                  onChangeText={setCoinSearch}
                  placeholder="Search coin or ticker"
                  placeholderTextColor={theme.inkFaint}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </View>

              <View style={styles.seg}>
                {(['popular', 'gainers', 'all'] as CoinFilter[]).map((f) => (
                  <TouchableOpacity
                    key={f}
                    style={[styles.segOpt, coinFilter === f && styles.segOptOn]}
                    onPress={() => setCoinFilter(f)}
                  >
                    <Text style={[styles.segOptText, coinFilter === f && styles.segOptTextOn]}>
                      {f === 'popular' ? 'Popular' : f === 'gainers' ? 'Gainers' : 'All'}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              <Text style={styles.sectionLabel}>Live markets</Text>

              {marketsLoading && markets.length === 0 ? (
                <ActivityIndicator color={theme.brand} style={{ marginTop: Spacing.L }} />
              ) : (
                <View style={styles.coinList}>
                  {visibleMarkets.map((m) => {
                    const up = (m.change24hPct ?? 0) >= 0;
                    return (
                      <TouchableOpacity
                        key={m.code}
                        style={styles.coinRow}
                        onPress={() => handlePickBuyAsset(m.code)}
                        activeOpacity={0.7}
                      >
                        <ProviderLogo
                          source={CRYPTO_LOGOS[m.code]}
                          fallbackLabel={m.name}
                          fallbackColor={theme.brand}
                          size={38}
                          style={{ marginRight: Spacing.M }}
                        />
                        <View style={styles.coinMid}>
                          <View style={styles.coinNameRow}>
                            <Text style={styles.coinName}>{m.name}</Text>
                            {m.stablecoin && <Text style={styles.coinTag}>STABLE</Text>}
                          </View>
                          <Text style={styles.coinTicker}>{m.code}</Text>
                          <Sparkline open={m.openNgn} low={m.lowNgn} high={m.highNgn} last={m.priceNgn} up={up} upColor={theme.up} downColor={theme.down} />
                        </View>
                        <View style={styles.coinRight}>
                          <Text style={styles.coinPrice}>{formatNaira(m.priceNgn)}</Text>
                          {m.change24hPct != null && (
                            <Text style={[styles.coinChange, { color: up ? theme.up : theme.down }]}>
                              {up ? '+' : ''}{m.change24hPct.toFixed(2)}%
                            </Text>
                          )}
                        </View>
                      </TouchableOpacity>
                    );
                  })}
                  {!marketsLoading && visibleMarkets.length === 0 && (
                    <Text style={styles.errorText}>
                      {markets.length === 0 ? 'Could not load live prices. Pull down to try again.' : 'No coins match.'}
                    </Text>
                  )}
                </View>
              )}
            </View>
          )}

          {step === 'amount' && selectedBuyAsset && (
            <View>
              <TouchableOpacity style={styles.backLink} onPress={() => setStep('pick')}>
                <Ionicons name="chevron-back" size={16} color={theme.inkFaint} />
                <Text style={styles.backLinkText}>Change coin</Text>
              </TouchableOpacity>

              <View style={styles.coinSummaryRow}>
                <ProviderLogo
                  source={CRYPTO_LOGOS[selectedBuyAsset]}
                  fallbackLabel={selectedMarket?.name ?? selectedBuyAsset}
                  fallbackColor={theme.brand}
                  size={38}
                  style={{ marginRight: Spacing.M }}
                />
                <View>
                  <Text style={styles.coinName}>{selectedMarket?.name ?? selectedBuyAsset}</Text>
                  {selectedMarket && <Text style={styles.coinTicker}>{formatNaira(selectedMarket.priceNgn)}</Text>}
                </View>
              </View>

              <View style={styles.bankTransferNotice}>
                <Ionicons name="business-outline" size={20} color={theme.brand} style={{ marginTop: 1 }} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.bankTransferNoticeTitle}>Paid by direct bank transfer</Text>
                  <Text style={styles.bankTransferNoticeText}>
                    You don't need to fund your KaysPay Wallet first — you'll transfer straight to a one-time account.
                  </Text>
                </View>
              </View>

              <Text style={styles.label}>Amount to spend (₦)</Text>
              {buyLimits && (
                <Text style={styles.hintText}>
                  Between {formatNaira(buyLimits.minNgn)} and {formatNaira(buyLimits.maxNgn)}
                </Text>
              )}
              <TextInput
                style={styles.input}
                value={buyNgn}
                onChangeText={(t) => setBuyNgn(t.replace(/[^0-9.]/g, ''))}
                placeholder="e.g. 5000"
                placeholderTextColor={theme.inkFaint}
                keyboardType="decimal-pad"
              />
              {buyBelowMin && buyLimits && (
                <Text style={styles.errorText}>
                  Minimum purchase is {formatNaira(buyLimits.minNgn)}.
                </Text>
              )}
              {buyAboveMax && buyLimits && (
                <Text style={styles.errorText}>
                  Maximum purchase is {formatNaira(buyLimits.maxNgn)}.
                </Text>
              )}

              {selectedMarket?.stablecoin ? (
                <>
                  <TouchableOpacity
                    style={styles.destinationToggleRow}
                    onPress={() => setBuyToExternal((v) => !v)}
                    activeOpacity={0.75}
                  >
                    <View style={[styles.checkbox, buyToExternal && styles.checkboxChecked]}>
                      {buyToExternal && <Text style={styles.checkboxMark}>✓</Text>}
                    </View>
                    <Text style={styles.checkLabel}>Send to a different wallet instead of my KaysPay Wallet</Text>
                  </TouchableOpacity>

                  {buyToExternal && (
                    <View>
                      <Text style={styles.label}>Network</Text>
                      <View style={styles.networkRow}>
                        {CRYPTO_NETWORKS.map((n) => (
                          <TouchableOpacity
                            key={n.key}
                            style={[styles.networkChip, buyDestNetwork === n.key && styles.networkChipSelected]}
                            onPress={() => setBuyDestNetwork(n.key)}
                          >
                            <Text style={[styles.networkChipText, buyDestNetwork === n.key && styles.networkChipTextSelected]}>
                              {n.label}
                            </Text>
                          </TouchableOpacity>
                        ))}
                      </View>

                      <Text style={styles.label}>Wallet Address</Text>
                      <TextInput
                        style={styles.input}
                        value={buyDestAddress}
                        onChangeText={setBuyDestAddress}
                        placeholder={`Paste your ${buyDestNetwork} address`}
                        placeholderTextColor={theme.inkFaint}
                        autoCapitalize="none"
                        autoCorrect={false}
                      />
                      {buyDestAddressError && <Text style={styles.errorText}>{buyDestAddressError}</Text>}

                      {buyDestAddressValid && (
                        <View style={styles.confirmBox}>
                          <Text style={styles.confirmWarning}>
                            This is riskier than a withdrawal: the USDT is delivered straight out of this purchase, with
                            no KaysPay balance to recover it from if the address or network is wrong.
                          </Text>
                          <TouchableOpacity style={styles.checkRow} onPress={() => setBuyDestVerified((v) => !v)}>
                            <View style={[styles.checkbox, buyDestVerified && styles.checkboxChecked]}>
                              {buyDestVerified && <Text style={styles.checkboxMark}>✓</Text>}
                            </View>
                            <Text style={styles.checkLabel}>I've checked this address and network are correct</Text>
                          </TouchableOpacity>
                        </View>
                      )}
                    </View>
                  )}
                </>
              ) : (
                <View style={styles.confirmBox}>
                  <Text style={styles.confirmText}>
                    Delivered to your KaysPay Wallet. The exact amount of {selectedBuyAsset} you receive is
                    confirmed once your transfer is priced.
                  </Text>
                </View>
              )}

              <TouchableOpacity
                style={[styles.primaryButton, (!canBuy || buyLoading) && styles.primaryButtonDisabled]}
                onPress={handleBuy}
                disabled={!canBuy || buyLoading}
              >
                {buyLoading ? (
                  <ActivityIndicator color={theme.background} />
                ) : (
                  <Text style={styles.primaryButtonText}>Confirm</Text>
                )}
              </TouchableOpacity>
            </View>
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
    kycGate: {
      alignItems: 'center',
      paddingVertical: Spacing.XL,
      paddingHorizontal: Spacing.M,
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

    search: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Spacing.S,
      backgroundColor: theme.surfaceRaised,
      borderWidth: 1,
      borderColor: theme.hairline,
      borderRadius: 13,
      paddingHorizontal: Spacing.M,
      height: Spacing.INPUT_HEIGHT,
    },
    searchInput: { flex: 1, ...Typography.BODY, color: theme.ink, padding: 0 },

    seg: {
      flexDirection: 'row',
      gap: 6,
      backgroundColor: theme.surfaceRaised,
      borderWidth: 1,
      borderColor: theme.hairline,
      borderRadius: 12,
      padding: 4,
      marginTop: Spacing.M,
    },
    segOpt: { flex: 1, alignItems: 'center', paddingVertical: Spacing.S, borderRadius: 9 },
    segOptOn: { backgroundColor: theme.surfaceRaised2 },
    segOptText: { ...Typography.CAPTION, color: theme.inkFaint, fontWeight: '600' },
    segOptTextOn: { color: theme.ink },

    sectionLabel: {
      ...Typography.CAPTION,
      fontFamily: MONO,
      color: theme.inkFaint,
      letterSpacing: 1,
      textTransform: 'uppercase',
      marginTop: Spacing.L,
      marginBottom: Spacing.XS,
    },

    coinList: { gap: Spacing.XS },
    coinRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: Spacing.M,
      borderBottomWidth: 1,
      borderBottomColor: theme.hairlineSoft,
    },
    coinMid: { flex: 1, gap: 3 },
    coinNameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    coinName: { ...Typography.BODY, color: theme.ink, fontWeight: '600' },
    coinTag: {
      ...Typography.CAPTION,
      fontFamily: MONO,
      fontSize: 9,
      fontWeight: '700',
      letterSpacing: 0.5,
      color: theme.gold,
      backgroundColor: theme.goldSoft,
      paddingHorizontal: 6,
      paddingVertical: 1,
      borderRadius: 999,
    },
    coinTicker: { ...Typography.CAPTION, fontFamily: MONO, color: theme.inkFaint },
    coinRight: { alignItems: 'flex-end' },
    coinPrice: { ...Typography.BODY, fontFamily: MONO, color: theme.ink, fontWeight: '600' },
    coinChange: { ...Typography.CAPTION, fontFamily: MONO, fontWeight: '600', marginTop: 2 },

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

    bankTransferNotice: {
      flexDirection: 'row',
      gap: Spacing.S,
      backgroundColor: `${theme.brand}1A`,
      borderRadius: Spacing.CARD_RADIUS,
      padding: Spacing.M,
      marginTop: Spacing.L,
    },
    bankTransferNoticeTitle: { ...Typography.BODY_SMALL, fontWeight: '700', color: theme.ink, marginBottom: 2 },
    bankTransferNoticeText: { ...Typography.CAPTION, color: theme.inkMuted, lineHeight: 18 },

    label: { ...Typography.SECTION_HEADING, color: theme.ink, marginTop: Spacing.M, marginBottom: Spacing.M },
    hintText: { ...Typography.CAPTION, color: theme.inkMuted, marginTop: Spacing.M },
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

    destinationToggleRow: { flexDirection: 'row', alignItems: 'center', marginTop: Spacing.L },
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
