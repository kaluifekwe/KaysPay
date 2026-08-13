import React, { useState, useCallback, useEffect } from 'react';
import * as Clipboard from 'expo-clipboard';
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
  StatusBar,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
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
  type QuidaxWalletBalance,
} from '../services/crypto.service';
import { useTransactionAuth } from '../components/TransactionAuthProvider';
import ResultStatusView, { type ResultStatus } from '../components/ResultStatusView';
import QrCodeView from '../components/QrCodeView';

interface CryptoScreenProps {
  navigation: { goBack: () => void };
}

type Tab = 'deposit' | 'buy' | 'sell' | 'withdraw';

// A deliberately darker theme for just this screen — the rest of the app
// stays on the shared light Colors palette, but a "your investment/crypto
// balance lives here" section reading as a distinct, premium space is a
// common, deliberate pattern (Binance, Trust Wallet) rather than an
// inconsistency. Scoped locally since nothing else in the app reuses it.
const Dark = {
  BG: '#0E1712',
  PANEL: '#131F19',
  PANEL_BORDER: '#1E2E25',
  CHIP: '#1B2A22',
  ACCENT: '#5FCB9A',
  TEXT: '#FFFFFF',
  TEXT_MUTED: '#B7CCC1',
  TEXT_FAINT: '#7FA895',
  BORDER: '#23342A',
  ERROR: '#E29A9A',
};

const TAB_ICONS: Record<Tab, keyof typeof Ionicons.glyphMap> = {
  deposit: 'arrow-down-circle-outline',
  buy: 'add-circle-outline',
  sell: 'arrow-up-circle-outline',
  withdraw: 'paper-plane-outline',
};
const TAB_LABELS: Record<Tab, string> = {
  deposit: 'Deposit',
  buy: 'Buy',
  sell: 'Sell',
  withdraw: 'Withdraw',
};

function formatUsdt(n: number): string {
  return `${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })} USDT`;
}

export default function CryptoScreen({ navigation }: CryptoScreenProps) {
  const { authorize } = useTransactionAuth();
  const insets = useSafeAreaInsets();

  const [tab, setTab] = useState<Tab>('deposit');
  const [ngnBalance, setNgnBalance] = useState<number | null>(null);
  const [usdtBalance, setUsdtBalance] = useState<number | null>(null);
  const [rate, setRate] = useState<number | null>(null);

  // Live balance held at Quidax under the user's own sub-account — kept
  // deliberately separate from usdtBalance (the old pooled-ledger number
  // above) until Sell/Withdraw/Buy are migrated onto Quidax in later
  // phases; showing them as one merged figure right now would be wrong,
  // since deposits here don't yet affect what Sell/Withdraw can spend.
  const [quidaxWallets, setQuidaxWallets] = useState<QuidaxWalletBalance[]>([]);
  const [quidaxLoadError, setQuidaxLoadError] = useState<string | null>(null);

  const [depositNetwork, setDepositNetwork] = useState<CryptoNetwork>('TRC20');
  const [depositAddress, setDepositAddress] = useState<string | null>(null);
  const [depositLoading, setDepositLoading] = useState(false);
  const [depositError, setDepositError] = useState<string | null>(null);
  const [addressCopied, setAddressCopied] = useState(false);

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
    const [walletResult, usdt, liveRate, saved, quidaxAccount] = await Promise.all([
      walletService.getWallet(),
      cryptoService.getBalance('USDT'),
      cryptoService.getQuoteRate(),
      cryptoService.listSavedAddresses('USDT'),
      cryptoService.getOrCreateAccount(),
    ]);
    if (walletResult.success && walletResult.wallet) setNgnBalance(walletResult.wallet.available_balance);
    setUsdtBalance(usdt);
    setRate(liveRate);
    setSavedAddresses(saved);
    if (quidaxAccount.success) {
      setQuidaxWallets(quidaxAccount.wallets);
      setQuidaxLoadError(null);
    } else {
      setQuidaxLoadError(quidaxAccount.error || 'Could not load your crypto account.');
    }
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const quidaxUsdt = quidaxWallets.find((w) => w.currency === 'USDT');

  // Any network change invalidates whatever address is on screen — never
  // show a TRC20 address after the user switched to BEP20.
  useEffect(() => {
    setDepositAddress(null);
    setDepositError(null);
    setAddressCopied(false);
  }, [depositNetwork]);

  const handleGenerateDepositAddress = useCallback(async () => {
    setDepositLoading(true);
    setDepositError(null);
    const result = await cryptoService.getDepositAddress(depositNetwork);
    setDepositLoading(false);
    if (result.success && result.address) {
      setDepositAddress(result.address);
    } else {
      setDepositError(result.error || 'Could not generate a deposit address.');
    }
  }, [depositNetwork]);

  const handleCopyDepositAddress = useCallback(async () => {
    if (!depositAddress) return;
    try {
      await Clipboard.setStringAsync(depositAddress);
      setAddressCopied(true);
      setTimeout(() => setAddressCopied(false), 2000);
    } catch {
      Alert.alert('Copy address', 'Could not copy the address. Please try again.');
    }
  }, [depositAddress]);

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
      <StatusBar barStyle="light-content" backgroundColor={Dark.BG} />
      <View style={styles.topBar}>
        <TouchableOpacity style={styles.backButton} activeOpacity={0.6} onPress={() => navigation.goBack()}>
          <Ionicons name="chevron-back" size={26} color={Dark.TEXT} />
        </TouchableOpacity>
        <Text style={styles.topTitle}>Crypto</Text>
      </View>

      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <View style={styles.hero}>
            <Text style={styles.heroLabel}>Deposited USDT</Text>
            <Text style={styles.heroValue}>
              {quidaxUsdt ? formatUsdt(Number(quidaxUsdt.balance)) : quidaxLoadError ? '—' : formatUsdt(0)}
            </Text>
            {quidaxLoadError ? (
              <Text style={styles.heroError}>{quidaxLoadError}</Text>
            ) : (
              <Text style={styles.heroSub}>
                Naira wallet {ngnBalance != null ? formatNaira(ngnBalance) : '—'}
                {rate != null ? ` · 1 USDT ≈ ${formatNaira(rate)}` : ''}
              </Text>
            )}
            {usdtBalance != null && usdtBalance > 0 && (
              <Text style={styles.heroLegacy}>+ {formatUsdt(usdtBalance)} from Buy (not yet deposited)</Text>
            )}
          </View>

          <View style={styles.actionsRow}>
            {(['deposit', 'buy', 'sell', 'withdraw'] as Tab[]).map((t) => (
              <TouchableOpacity key={t} style={styles.actionItem} onPress={() => setTab(t)} activeOpacity={0.75}>
                <View style={[styles.actionIcon, tab === t && styles.actionIconActive]}>
                  <Ionicons name={TAB_ICONS[t]} size={20} color={Dark.ACCENT} />
                </View>
                <Text style={[styles.actionLabel, tab === t && styles.actionLabelActive]}>{TAB_LABELS[t]}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <View style={styles.panel}>
            {tab === 'deposit' && (
              <View>
                <Text style={styles.hintText}>
                  Bring USDT you already hold on Binance, Bybit, or another exchange into your own crypto account here.
                </Text>

                <Text style={styles.label}>Network</Text>
                <View style={styles.networkRow}>
                  {CRYPTO_NETWORKS.map((n) => (
                    <TouchableOpacity
                      key={n.key}
                      style={[styles.networkChip, depositNetwork === n.key && styles.networkChipSelected]}
                      onPress={() => setDepositNetwork(n.key)}
                    >
                      <Text style={[styles.networkChipText, depositNetwork === n.key && styles.networkChipTextSelected]}>
                        {n.label}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>

                {depositAddress ? (
                  <View style={styles.confirmBox}>
                    <View style={styles.qrCard}>
                      <QrCodeView value={depositAddress} size={160} />
                    </View>
                    <Text style={styles.depositAddressText} selectable>{depositAddress}</Text>
                    <TouchableOpacity style={styles.copyAddressButton} onPress={handleCopyDepositAddress}>
                      <Text style={styles.copyAddressButtonText}>{addressCopied ? 'Copied ✓' : 'Copy Address'}</Text>
                    </TouchableOpacity>
                    <Text style={styles.confirmWarning}>
                      Only send USDT on {depositNetwork} to this address. Sending on the wrong network, or any other
                      asset, cannot be recovered.
                    </Text>
                  </View>
                ) : (
                  <TouchableOpacity
                    style={[styles.primaryButton, depositLoading && styles.primaryButtonDisabled]}
                    onPress={handleGenerateDepositAddress}
                    disabled={depositLoading}
                  >
                    {depositLoading ? (
                      <ActivityIndicator color={Dark.BG} />
                    ) : (
                      <Text style={styles.primaryButtonText}>Generate Deposit Address</Text>
                    )}
                  </TouchableOpacity>
                )}
                {depositError && <Text style={styles.errorText}>{depositError}</Text>}
              </View>
            )}

            {tab === 'buy' && (
              <View>
                <Text style={styles.label}>Amount (USD)</Text>
                <TextInput
                  style={styles.input}
                  value={buyUsd}
                  onChangeText={(t) => setBuyUsd(t.replace(/[^0-9.]/g, ''))}
                  placeholder="e.g. 30"
                  placeholderTextColor={Dark.TEXT_FAINT}
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
              <View>
                <Text style={styles.label}>Amount (USDT)</Text>
                <TextInput
                  style={styles.input}
                  value={sellUsdt}
                  onChangeText={(t) => setSellUsdt(t.replace(/[^0-9.]/g, ''))}
                  placeholder="e.g. 10"
                  placeholderTextColor={Dark.TEXT_FAINT}
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
              <View>
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
                  placeholderTextColor={Dark.TEXT_FAINT}
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
                  placeholderTextColor={Dark.TEXT_FAINT}
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
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Dark.BG },
  flex: { flex: 1 },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.SCREEN_PADDING,
    paddingTop: Spacing.S,
    paddingBottom: Spacing.S,
  },
  backButton: { width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
  topTitle: { ...Typography.SECTION_HEADING, color: Dark.TEXT, marginLeft: Spacing.S },
  scrollContent: { paddingHorizontal: Spacing.SCREEN_PADDING, paddingBottom: 60 },

  hero: { paddingTop: Spacing.M, paddingBottom: Spacing.L },
  heroLabel: { ...Typography.CAPTION, color: Dark.TEXT_FAINT, marginBottom: Spacing.XS },
  heroValue: { fontSize: 30, fontWeight: '600', color: Dark.TEXT, marginBottom: Spacing.S },
  heroSub: { ...Typography.CAPTION, color: Dark.TEXT_FAINT },
  heroError: { ...Typography.CAPTION, color: Dark.ERROR },
  heroLegacy: { ...Typography.CAPTION, color: Dark.TEXT_MUTED, marginTop: Spacing.XS },

  actionsRow: { flexDirection: 'row', justifyContent: 'space-around', paddingBottom: Spacing.L },
  actionItem: { alignItems: 'center', minWidth: 64 },
  actionIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: Dark.CHIP,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: Spacing.XS,
  },
  actionIconActive: { borderWidth: 1.5, borderColor: Dark.ACCENT },
  actionLabel: { ...Typography.CAPTION, color: Dark.TEXT_MUTED },
  actionLabelActive: { color: Dark.ACCENT, fontWeight: '700' },

  panel: {
    backgroundColor: Dark.PANEL,
    borderRadius: Spacing.CARD_RADIUS,
    borderWidth: 1,
    borderColor: Dark.PANEL_BORDER,
    padding: Spacing.CARD_PADDING,
  },
  label: { ...Typography.SECTION_HEADING, color: Dark.TEXT, marginTop: Spacing.M, marginBottom: Spacing.M },
  input: {
    height: Spacing.INPUT_HEIGHT,
    borderWidth: Spacing.INPUT_BORDER_WIDTH,
    borderColor: Dark.BORDER,
    borderRadius: Spacing.BUTTON_RADIUS,
    paddingHorizontal: Spacing.L,
    ...Typography.BODY,
    color: Dark.TEXT,
    backgroundColor: Dark.BG,
  },
  estimateText: { ...Typography.BODY, color: Dark.ACCENT, fontWeight: '700', marginTop: Spacing.S },
  errorText: { ...Typography.ERROR, color: Dark.ERROR, marginTop: Spacing.S },
  hintText: { ...Typography.CAPTION, color: Dark.TEXT_FAINT, marginTop: Spacing.M },
  notLiveBanner: {
    ...Typography.CAPTION,
    color: Dark.ACCENT,
    backgroundColor: Dark.CHIP,
    borderRadius: Spacing.CARD_RADIUS,
    padding: Spacing.M,
    marginBottom: Spacing.L,
  },

  primaryButton: {
    height: Spacing.BUTTON_HEIGHT_PRIMARY,
    backgroundColor: Dark.ACCENT,
    borderRadius: Spacing.BUTTON_RADIUS,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: Spacing.L,
  },
  primaryButtonDisabled: { opacity: 0.5 },
  primaryButtonText: { ...Typography.BUTTON_TEXT, color: Dark.BG },

  savedRow: {
    borderWidth: 1,
    borderColor: Dark.BORDER,
    borderRadius: Spacing.CARD_RADIUS,
    padding: Spacing.M,
    marginBottom: Spacing.S,
  },
  savedRowText: { ...Typography.BODY, color: Dark.TEXT },

  networkRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.S },
  networkChip: {
    paddingHorizontal: Spacing.M,
    paddingVertical: Spacing.S,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: Dark.BORDER,
  },
  networkChipSelected: { backgroundColor: Dark.CHIP, borderColor: Dark.ACCENT },
  networkChipText: { ...Typography.CAPTION, color: Dark.TEXT_MUTED, fontWeight: '600' },
  networkChipTextSelected: { color: Dark.ACCENT },

  qrCard: { alignSelf: 'center', backgroundColor: Colors.WHITE, borderRadius: 12, padding: Spacing.M, marginBottom: Spacing.M },
  depositAddressText: { ...Typography.BODY, color: Dark.TEXT, textAlign: 'center', marginBottom: Spacing.M },
  copyAddressButton: {
    height: Spacing.BUTTON_HEIGHT_PRIMARY,
    borderRadius: Spacing.BUTTON_RADIUS,
    borderWidth: 1,
    borderColor: Dark.ACCENT,
    justifyContent: 'center',
    alignItems: 'center',
  },
  copyAddressButtonText: { ...Typography.BUTTON_TEXT, color: Dark.ACCENT },

  confirmBox: {
    backgroundColor: Dark.BG,
    borderRadius: Spacing.CARD_RADIUS,
    borderWidth: 1,
    borderColor: Dark.BORDER,
    padding: Spacing.CARD_PADDING,
    marginTop: Spacing.L,
  },
  confirmText: { ...Typography.BODY, color: Dark.TEXT },
  confirmWarning: { ...Typography.CAPTION, color: Dark.ERROR, marginTop: Spacing.S },
  checkRow: { flexDirection: 'row', alignItems: 'center', marginTop: Spacing.M },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: Dark.ACCENT,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: Spacing.M,
  },
  checkboxChecked: { backgroundColor: Dark.ACCENT },
  checkboxMark: { color: Dark.BG, fontSize: 14, fontWeight: '700' },
  checkLabel: { ...Typography.CAPTION, color: Dark.TEXT, flex: 1 },
});
