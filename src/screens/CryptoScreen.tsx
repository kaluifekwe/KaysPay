import React, { useState, useCallback, useEffect } from 'react';
import {
  View,
  StyleSheet,
  Text,
  ScrollView,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Colors } from '../constants/colors';
import { Typography } from '../constants/typography';
import { Spacing } from '../constants/spacing';
import { formatNaira } from '../utils/formatCurrency';
import { walletService } from '../services/wallet.service';
import {
  cryptoService,
  isValidCryptoAddress,
  CRYPTO_NETWORKS,
  type CryptoNetwork,
  type SavedCryptoAddress,
} from '../services/crypto.service';
import { useTransactionAuth } from '../components/TransactionAuthProvider';
import ResultStatusView, { type ResultStatus } from '../components/ResultStatusView';

interface CryptoScreenProps {
  navigation: { goBack: () => void };
}

type Tab = 'buy' | 'sell' | 'withdraw';

function formatUsdt(n: number): string {
  return `${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })} USDT`;
}

export default function CryptoScreen({ navigation }: CryptoScreenProps) {
  const { authorize } = useTransactionAuth();
  const insets = useSafeAreaInsets();

  const [tab, setTab] = useState<Tab>('buy');
  const [ngnBalance, setNgnBalance] = useState<number | null>(null);
  const [usdtBalance, setUsdtBalance] = useState<number | null>(null);
  const [rate, setRate] = useState<number | null>(null);

  const [actionState, setActionState] = useState<ResultStatus | 'idle'>('idle');
  const [actionError, setActionError] = useState('');
  const [actionAmountNgn, setActionAmountNgn] = useState<number | null>(null);

  const [buyUsd, setBuyUsd] = useState('');
  const [sellUsdt, setSellUsdt] = useState('');

  const [wdNetwork, setWdNetwork] = useState<CryptoNetwork>('TRC20');
  const [wdAddress, setWdAddress] = useState('');
  const [wdAmount, setWdAmount] = useState('');
  const [wdVerified, setWdVerified] = useState(false);
  const [savedAddresses, setSavedAddresses] = useState<SavedCryptoAddress[]>([]);

  const loadAll = useCallback(async () => {
    const [walletResult, usdt, liveRate, saved] = await Promise.all([
      walletService.getWallet(),
      cryptoService.getBalance('USDT'),
      cryptoService.getQuoteRate(),
      cryptoService.listSavedAddresses('USDT'),
    ]);
    if (walletResult.success && walletResult.wallet) setNgnBalance(walletResult.wallet.available_balance);
    setUsdtBalance(usdt);
    setRate(liveRate);
    setSavedAddresses(saved);
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  // Any edit to the withdrawal address/network invalidates the "I've
  // checked this" confirmation — never let a stale confirmation carry over
  // to a different address, same discipline as the meter-verify flow.
  useEffect(() => {
    setWdVerified(false);
  }, [wdAddress, wdNetwork]);

  const numericBuyUsd = parseFloat(buyUsd);
  const numericSellUsdt = parseFloat(sellUsdt);
  const numericWdAmount = parseFloat(wdAmount);

  const buyNgnEstimate = rate && numericBuyUsd > 0 ? numericBuyUsd * rate : null;
  const sellNgnEstimate = rate && numericSellUsdt > 0 ? numericSellUsdt * rate : null;

  const wdAddressValid = wdAddress.trim().length > 0 && isValidCryptoAddress(wdNetwork, wdAddress);
  const wdAddressError = wdAddress.trim().length > 0 && !wdAddressValid
    ? `This doesn't look like a valid ${wdNetwork} address.`
    : null;

  const canBuy = Number.isFinite(numericBuyUsd) && numericBuyUsd >= 1 && numericBuyUsd <= 2000
    && ngnBalance != null && buyNgnEstimate != null && buyNgnEstimate <= ngnBalance;
  const canSell = Number.isFinite(numericSellUsdt) && numericSellUsdt >= 1 && numericSellUsdt <= 2000
    && usdtBalance != null && numericSellUsdt <= usdtBalance;
  const canWithdraw = Number.isFinite(numericWdAmount) && numericWdAmount >= 5 && numericWdAmount <= 2000
    && usdtBalance != null && numericWdAmount <= usdtBalance && wdAddressValid && wdVerified;

  const handleBuy = useCallback(async () => {
    if (!canBuy) return;
    const authResult = await authorize({ title: 'Confirm Crypto Purchase', amount: buyNgnEstimate ?? undefined });
    if (!authResult) return;
    setActionAmountNgn(buyNgnEstimate);
    setActionState('processing');
    const result = await cryptoService.buy(numericBuyUsd, authResult.token);
    if (result.success) {
      setActionState('success');
      setBuyUsd('');
      loadAll();
    } else {
      setActionError(result.error || 'Purchase failed. Please try again.');
      setActionState('failed');
    }
  }, [canBuy, buyNgnEstimate, numericBuyUsd, authorize, loadAll]);

  const handleSell = useCallback(async () => {
    if (!canSell) return;
    const authResult = await authorize({ title: 'Confirm Crypto Sale', amount: sellNgnEstimate ?? undefined });
    if (!authResult) return;
    setActionAmountNgn(sellNgnEstimate);
    setActionState('processing');
    const result = await cryptoService.sell(numericSellUsdt, authResult.token);
    if (result.success) {
      setActionState('success');
      setSellUsdt('');
      loadAll();
    } else {
      setActionError(result.error || 'Sale failed. Please try again.');
      setActionState('failed');
    }
  }, [canSell, sellNgnEstimate, numericSellUsdt, authorize, loadAll]);

  const submitWithdraw = useCallback(async () => {
    const authResult = await authorize({
      title: 'Confirm Crypto Withdrawal',
      subtitle: `${numericWdAmount} USDT · ${wdNetwork} · ${wdAddress.trim()}`,
    });
    if (!authResult) return;
    setActionAmountNgn(null);
    setActionState('processing');
    const result = await cryptoService.withdraw(wdNetwork, wdAddress, numericWdAmount, authResult.token);
    if (result.success) {
      setActionState('success');
      await cryptoService.saveAddress(wdNetwork, wdAddress, '');
      setWdAddress('');
      setWdAmount('');
      setWdVerified(false);
      loadAll();
    } else {
      setActionError(result.error || 'Withdrawal failed. Please try again.');
      setActionState('failed');
    }
  }, [numericWdAmount, wdNetwork, wdAddress, authorize, loadAll]);

  const handleWithdraw = useCallback(() => {
    if (!canWithdraw) return;
    submitWithdraw();
  }, [canWithdraw, submitWithdraw]);

  const handlePickSaved = useCallback((addr: SavedCryptoAddress) => {
    setWdNetwork(addr.network);
    setWdAddress(addr.address);
    setWdVerified(false);
    cryptoService.touchAddress(addr.id);
  }, []);

  if (actionState !== 'idle') {
    return (
      <ResultStatusView
        status={actionState}
        headerTitle="Crypto"
        amount={actionAmountNgn ?? undefined}
        message={actionState === 'failed' ? actionError : undefined}
        onDone={() => setActionState('idle')}
      />
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      <View style={styles.topBar}>
        <TouchableOpacity style={styles.backButton} activeOpacity={0.6} onPress={() => navigation.goBack()}>
          <Text style={styles.backText}>{'<'}</Text>
        </TouchableOpacity>
        <Text style={styles.topTitle}>Crypto</Text>
      </View>

      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <View style={styles.balanceRow}>
            <View style={styles.balanceCard}>
              <Text style={styles.balanceLabel}>Wallet</Text>
              <Text style={styles.balanceValue}>{ngnBalance != null ? formatNaira(ngnBalance) : '—'}</Text>
            </View>
            <View style={styles.balanceCard}>
              <Text style={styles.balanceLabel}>USDT Balance</Text>
              <Text style={styles.balanceValue}>{usdtBalance != null ? formatUsdt(usdtBalance) : '—'}</Text>
            </View>
          </View>
          {rate != null && (
            <Text style={styles.rateText}>1 USDT ≈ {formatNaira(rate)}</Text>
          )}

          <View style={styles.tabs}>
            {(['buy', 'sell', 'withdraw'] as Tab[]).map((t) => (
              <TouchableOpacity
                key={t}
                style={[styles.tab, tab === t && styles.tabActive]}
                onPress={() => setTab(t)}
              >
                <Text style={[styles.tabText, tab === t && styles.tabTextActive]}>
                  {t === 'buy' ? 'Buy' : t === 'sell' ? 'Sell' : 'Withdraw'}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {tab === 'buy' && (
            <View style={styles.section}>
              <Text style={styles.label}>Amount (USD)</Text>
              <TextInput
                style={styles.input}
                value={buyUsd}
                onChangeText={(t) => setBuyUsd(t.replace(/[^0-9.]/g, ''))}
                placeholder="e.g. 30"
                placeholderTextColor={Colors.GRAY}
                keyboardType="decimal-pad"
              />
              {buyNgnEstimate != null && (
                <Text style={styles.estimateText}>
                  ≈ {numericBuyUsd.toFixed(2)} USDT · {formatNaira(buyNgnEstimate)}
                </Text>
              )}
              {ngnBalance != null && buyNgnEstimate != null && buyNgnEstimate > ngnBalance && (
                <Text style={styles.errorText}>Insufficient wallet balance.</Text>
              )}
              <TouchableOpacity
                style={[styles.primaryButton, !canBuy && styles.primaryButtonDisabled]}
                onPress={handleBuy}
                disabled={!canBuy}
              >
                <Text style={styles.primaryButtonText}>Buy USDT</Text>
              </TouchableOpacity>
            </View>
          )}

          {tab === 'sell' && (
            <View style={styles.section}>
              <Text style={styles.label}>Amount (USDT)</Text>
              <TextInput
                style={styles.input}
                value={sellUsdt}
                onChangeText={(t) => setSellUsdt(t.replace(/[^0-9.]/g, ''))}
                placeholder="e.g. 10"
                placeholderTextColor={Colors.GRAY}
                keyboardType="decimal-pad"
              />
              {sellNgnEstimate != null && (
                <Text style={styles.estimateText}>≈ {formatNaira(sellNgnEstimate)}</Text>
              )}
              {usdtBalance != null && numericSellUsdt > usdtBalance && (
                <Text style={styles.errorText}>Insufficient USDT balance.</Text>
              )}
              <TouchableOpacity
                style={[styles.primaryButton, !canSell && styles.primaryButtonDisabled]}
                onPress={handleSell}
                disabled={!canSell}
              >
                <Text style={styles.primaryButtonText}>Sell USDT</Text>
              </TouchableOpacity>
              <Text style={styles.hintText}>Proceeds go straight to your wallet — withdraw to your bank from Home as usual.</Text>
            </View>
          )}

          {tab === 'withdraw' && (
            <View style={styles.section}>
              <Text style={styles.notLiveBanner}>
                External wallet withdrawals aren't live yet — you can set everything up now, but sending will show
                "not available" until this goes live.
              </Text>

              {savedAddresses.length > 0 && (
                <>
                  <Text style={styles.label}>Saved addresses</Text>
                  {savedAddresses.map((a) => (
                    <TouchableOpacity key={a.id} style={styles.savedRow} onPress={() => handlePickSaved(a)}>
                      <Text style={styles.savedRowText} numberOfLines={1}>
                        {a.label ? `${a.label} · ` : ''}{a.address.slice(0, 6)}...{a.address.slice(-4)} ({a.network})
                      </Text>
                    </TouchableOpacity>
                  ))}
                </>
              )}

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

              <Text style={styles.label}>Wallet Address</Text>
              <TextInput
                style={styles.input}
                value={wdAddress}
                onChangeText={setWdAddress}
                placeholder={`Paste your ${wdNetwork} address`}
                placeholderTextColor={Colors.GRAY}
                autoCapitalize="none"
                autoCorrect={false}
              />
              {wdAddressError && <Text style={styles.errorText}>{wdAddressError}</Text>}

              <Text style={styles.label}>Amount (USDT)</Text>
              <TextInput
                style={styles.input}
                value={wdAmount}
                onChangeText={(t) => setWdAmount(t.replace(/[^0-9.]/g, ''))}
                placeholder="e.g. 20"
                placeholderTextColor={Colors.GRAY}
                keyboardType="decimal-pad"
              />
              {usdtBalance != null && numericWdAmount > usdtBalance && (
                <Text style={styles.errorText}>Insufficient USDT balance.</Text>
              )}

              {wdAddressValid && numericWdAmount > 0 && (
                <View style={styles.confirmBox}>
                  <Text style={styles.confirmText}>
                    Sending {Number.isFinite(numericWdAmount) ? numericWdAmount : 0} USDT on {wdNetwork} to{'\n'}
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
                style={[styles.primaryButton, !canWithdraw && styles.primaryButtonDisabled]}
                onPress={handleWithdraw}
                disabled={!canWithdraw}
              >
                <Text style={styles.primaryButtonText}>Withdraw USDT</Text>
              </TouchableOpacity>
            </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.WHITE },
  flex: { flex: 1 },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.SCREEN_PADDING,
    paddingTop: Spacing.S,
    paddingBottom: Spacing.S,
  },
  backButton: { width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
  backText: { fontSize: 26, fontWeight: '600', color: Colors.DARK },
  topTitle: { ...Typography.SECTION_HEADING, color: Colors.DARK, marginLeft: Spacing.S },
  scrollContent: { paddingHorizontal: Spacing.SCREEN_PADDING, paddingBottom: 60 },

  balanceRow: { flexDirection: 'row', gap: Spacing.M, marginTop: Spacing.S },
  balanceCard: {
    flex: 1,
    backgroundColor: Colors.LIGHT_GRAY,
    borderRadius: Spacing.CARD_RADIUS,
    padding: Spacing.CARD_PADDING,
  },
  balanceLabel: { ...Typography.CAPTION, color: Colors.GRAY },
  balanceValue: { ...Typography.CARD_TITLE, marginTop: Spacing.XS },
  rateText: { ...Typography.CAPTION, color: Colors.GRAY, textAlign: 'center', marginTop: Spacing.M },

  tabs: {
    flexDirection: 'row',
    backgroundColor: Colors.LIGHT_GRAY,
    borderRadius: Spacing.BUTTON_RADIUS,
    padding: 4,
    marginTop: Spacing.L,
    marginBottom: Spacing.L,
  },
  tab: { flex: 1, paddingVertical: Spacing.S, borderRadius: Spacing.BUTTON_RADIUS - 2, alignItems: 'center' },
  tabActive: { backgroundColor: Colors.WHITE },
  tabText: { ...Typography.BODY, color: Colors.GRAY, fontWeight: '600' },
  tabTextActive: { color: Colors.GREEN_DARK },

  section: { marginBottom: Spacing.XL },
  label: { ...Typography.SECTION_HEADING, marginTop: Spacing.M, marginBottom: Spacing.M },
  input: {
    height: Spacing.INPUT_HEIGHT,
    borderWidth: Spacing.INPUT_BORDER_WIDTH,
    borderColor: Colors.BORDER,
    borderRadius: Spacing.BUTTON_RADIUS,
    paddingHorizontal: Spacing.L,
    ...Typography.BODY,
    color: Colors.DARK,
  },
  estimateText: { ...Typography.BODY, color: Colors.GREEN, fontWeight: '700', marginTop: Spacing.S },
  errorText: { ...Typography.ERROR, marginTop: Spacing.S },
  hintText: { ...Typography.CAPTION, color: Colors.GRAY, marginTop: Spacing.M },
  notLiveBanner: {
    ...Typography.CAPTION,
    color: Colors.GREEN_DARK,
    backgroundColor: Colors.GREEN_10,
    borderRadius: Spacing.CARD_RADIUS,
    padding: Spacing.M,
    marginBottom: Spacing.L,
  },

  primaryButton: {
    height: Spacing.BUTTON_HEIGHT_PRIMARY,
    backgroundColor: Colors.GREEN,
    borderRadius: Spacing.BUTTON_RADIUS,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: Spacing.L,
  },
  primaryButtonDisabled: { opacity: 0.5 },
  primaryButtonText: { ...Typography.BUTTON_TEXT },

  savedRow: {
    borderWidth: 1,
    borderColor: Colors.BORDER,
    borderRadius: Spacing.CARD_RADIUS,
    padding: Spacing.M,
    marginBottom: Spacing.S,
  },
  savedRowText: { ...Typography.BODY, color: Colors.DARK },

  networkRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.S },
  networkChip: {
    paddingHorizontal: Spacing.M,
    paddingVertical: Spacing.S,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: Colors.BORDER,
  },
  networkChipSelected: { backgroundColor: Colors.GREEN_10, borderColor: Colors.GREEN },
  networkChipText: { ...Typography.CAPTION, color: Colors.GRAY, fontWeight: '600' },
  networkChipTextSelected: { color: Colors.GREEN_DARK },

  confirmBox: {
    backgroundColor: Colors.LIGHT_GRAY,
    borderRadius: Spacing.CARD_RADIUS,
    padding: Spacing.CARD_PADDING,
    marginTop: Spacing.L,
  },
  confirmText: { ...Typography.BODY, color: Colors.DARK },
  confirmWarning: { ...Typography.CAPTION, color: Colors.ERROR, marginTop: Spacing.S },
  checkRow: { flexDirection: 'row', alignItems: 'center', marginTop: Spacing.M },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: Colors.GREEN,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: Spacing.M,
  },
  checkboxChecked: { backgroundColor: Colors.GREEN },
  checkboxMark: { color: Colors.WHITE, fontSize: 14, fontWeight: '700' },
  checkLabel: { ...Typography.CAPTION, color: Colors.DARK, flex: 1 },
});
