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
  type CryptoBuyPayment,
  type BuyAsset,
  type MarketCoin,
} from '../services/crypto.service';
import { useTransactionAuth } from '../components/TransactionAuthProvider';
import ResultStatusView, { type ResultStatus } from '../components/ResultStatusView';
import QrCodeView from '../components/QrCodeView';

interface CryptoScreenProps {
  navigation: { goBack: () => void };
}

type Tab = 'deposit' | 'buy' | 'sell' | 'withdraw';

// Crypto gets its own dark, trading-terminal treatment — deliberately
// distinct from the rest of the app's light screens, the way a bank app's
// investing tab often reads differently from its everyday banking screens.
// Kept local to this file rather than folded into the shared Colors
// constants, since nothing else in the app uses it.
const DARK = {
  void: '#0A100C',
  surface: '#121912',
  raised: '#1B241C',
  raised2: '#212C22',
  hairline: '#28352C',
  hairlineSoft: '#1E2921',
  ink: '#EFF5F0',
  inkMuted: '#8FA294',
  inkFaint: '#5C6E62',
  brand: '#35B073',
  brandSoft: '#1E4A31',
  gold: '#E7B451',
  goldSoft: '#4A3A1C',
  up: '#5FD98A',
  down: '#F16A5C',
  errorBg: '#3A1F1C',
};

const HERO_BG = DARK.raised;
const HERO_TEXT_MUTED = DARK.inkMuted;
const HERO_ERROR = DARK.down;

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

// Non-stablecoin amounts need more precision (a BTC amount is usually
// < 0.01) than USDT's 2-6dp is built for.
function formatCoin(n: number, code: string): string {
  return `${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 8 })} ${code}`;
}

export default function CryptoScreen({ navigation }: CryptoScreenProps) {
  const { authorize } = useTransactionAuth();
  const insets = useSafeAreaInsets();

  const [tab, setTab] = useState<Tab>('deposit');
  const [ngnBalance, setNgnBalance] = useState<number | null>(null);
  const [usdtBalance, setUsdtBalance] = useState<number | null>(null);
  // Live USDT/NGN market price from Quidax. buyRate is the ask, sellRate the
  // bid — each side of the screen quotes the price it would really get.
  const [rate, setRate] = useState<number | null>(null);
  const [buyRate, setBuyRate] = useState<number | null>(null);
  const [sellRate, setSellRate] = useState<number | null>(null);

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
  // Sell and withdraw are accepted-then-settled, so the result screen needs
  // to say "processing", not imply the money already moved.
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionAmountNgn, setActionAmountNgn] = useState<number | null>(null);

  // Buy is a 4-step flow: pick a coin from live prices, set a USDT budget,
  // review the quote, then (USDT only) choose where it's delivered.
  const [buyStep, setBuyStep] = useState<'pick' | 'amount' | 'review' | 'destination'>('pick');
  const [markets, setMarkets] = useState<MarketCoin[]>([]);
  const [marketsLoading, setMarketsLoading] = useState(false);
  const [usdtNgnRate, setUsdtNgnRate] = useState<number | null>(null);
  const [selectedBuyAsset, setSelectedBuyAsset] = useState<BuyAsset | null>(null);
  const [buyUsdt, setBuyUsdt] = useState('');
  // Where a purchase should be delivered: the customer's own KaysPay crypto
  // account (default), or an external wallet they supply — same address/
  // network validation as Withdraw, since a wrong entry here is even less
  // recoverable (Quidax delivers straight out of the purchase, with no
  // KaysPay-side balance to recover it from). Only offered for USDT — every
  // other coin needs a swap leg first, so it always lands in the KaysPay
  // account (see crypto.service.ts's buy() doc comment).
  const [buyToExternal, setBuyToExternal] = useState(false);
  const [buyDestNetwork, setBuyDestNetwork] = useState<CryptoNetwork>('TRC20');
  const [buyDestAddress, setBuyDestAddress] = useState('');
  const [buyDestVerified, setBuyDestVerified] = useState(false);
  const [buyLoading, setBuyLoading] = useState(false);
  // A started purchase isn't complete — Quidax hands back a one-time bank
  // account and the app waits for the transfer, same as any other
  // bank-transfer funding flow already in the app.
  const [pendingBuyPayment, setPendingBuyPayment] = useState<{
    payment: CryptoBuyPayment;
    estimatedCrypto: number;
    destinationType: 'kayspay_account' | 'external_wallet';
    asset: BuyAsset;
    pendingSwap: boolean;
  } | null>(null);
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
    setRate(liveRate?.rate ?? null);
    setBuyRate(liveRate?.buyRate ?? null);
    setSellRate(liveRate?.sellRate ?? null);
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

  const loadMarkets = useCallback(async () => {
    setMarketsLoading(true);
    const result = await cryptoService.getMarkets();
    setMarketsLoading(false);
    if (result) {
      setMarkets(result.coins);
      setUsdtNgnRate(result.usdtNgnRate);
    }
  }, []);

  // Fetched lazily — only once the customer actually opens Buy, and only
  // the first time, since prices only need to be fresh while this screen
  // is actually up for a purchase.
  useEffect(() => {
    if (tab === 'buy' && markets.length === 0 && !marketsLoading) {
      loadMarkets();
    }
  }, [tab, markets.length, marketsLoading, loadMarkets]);

  const handleSelectTab = useCallback((t: Tab) => {
    setTab(t);
    if (t === 'buy') {
      setBuyStep('pick');
      setSelectedBuyAsset(null);
      setBuyUsdt('');
      setBuyToExternal(false);
    }
  }, []);

  const handlePickBuyAsset = useCallback((code: BuyAsset) => {
    setSelectedBuyAsset(code);
    setBuyUsdt('');
    setBuyToExternal(false);
    setBuyStep('amount');
  }, []);

  const quidaxUsdt = quidaxWallets.find((w) => w.currency === 'USDT');
  // Sell and Withdraw both spend the real balance held in the user's own
  // Quidax sub-account — never the legacy `usdtBalance` ledger number,
  // which only backs the not-yet-migrated Buy flow.
  const quidaxUsdtBalance = quidaxUsdt ? Number(quidaxUsdt.balance) : null;

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

  useEffect(() => {
    setBuyDestVerified(false);
  }, [buyDestAddress, buyDestNetwork]);

  const numericBuyUsdt = parseFloat(buyUsdt);
  const numericSellUsdt = parseFloat(sellUsdt);
  const numericWdAmount = parseFloat(wdAmount);

  const selectedMarket = markets.find((m) => m.code === selectedBuyAsset) || null;
  const buyNgnEstimate = usdtNgnRate && numericBuyUsdt > 0 ? numericBuyUsdt * usdtNgnRate : null;
  // Only meaningful for a swap-target coin — for USDT itself the "coin" IS
  // the USDT amount, so this is left null and the screens show buyNgnEstimate.
  const buyCoinEstimate = selectedMarket && !selectedMarket.stablecoin && buyNgnEstimate != null && selectedMarket.priceNgn > 0
    ? buyNgnEstimate / selectedMarket.priceNgn
    : null;
  const sellNgnEstimate = sellRate && numericSellUsdt > 0 ? numericSellUsdt * sellRate : null;

  const wdAddressValid = wdAddress.trim().length > 0 && isValidCryptoAddress(wdNetwork, wdAddress);
  const wdAddressError = wdAddress.trim().length > 0 && !wdAddressValid
    ? `This doesn't look like a valid ${wdNetwork} address.`
    : null;

  const buyDestAddressValid = buyDestAddress.trim().length > 0 && isValidCryptoAddress(buyDestNetwork, buyDestAddress);
  const buyDestAddressError = buyDestAddress.trim().length > 0 && !buyDestAddressValid
    ? `This doesn't look like a valid ${buyDestNetwork} address.`
    : null;

  const canBuy = !!selectedBuyAsset && Number.isFinite(numericBuyUsdt) && numericBuyUsdt > 0
    && (!buyToExternal || (buyDestAddressValid && buyDestVerified));
  const canSell = Number.isFinite(numericSellUsdt) && numericSellUsdt >= 1 && numericSellUsdt <= 2000
    && quidaxUsdtBalance != null && numericSellUsdt <= quidaxUsdtBalance;
  const canWithdraw = Number.isFinite(numericWdAmount) && numericWdAmount >= 5 && numericWdAmount <= 2000
    && quidaxUsdtBalance != null && numericWdAmount <= quidaxUsdtBalance && wdAddressValid && wdVerified;

  const handleBuy = useCallback(async () => {
    if (!canBuy || !selectedBuyAsset) return;
    const subtitle = buyToExternal
      ? `To ${buyDestNetwork} wallet ${buyDestAddress.trim()}`
      : 'To your KaysPay crypto account';
    const authResult = await authorize({
      title: `Confirm ${selectedBuyAsset} Purchase`,
      amount: buyNgnEstimate ?? undefined,
      subtitle,
    });
    if (!authResult) return;
    setBuyLoading(true);
    const result = await cryptoService.buy(
      selectedBuyAsset,
      numericBuyUsdt,
      authResult.token,
      buyToExternal ? { network: buyDestNetwork, address: buyDestAddress.trim() } : undefined,
    );
    setBuyLoading(false);
    if (result.success && result.payment) {
      setPendingBuyPayment({
        payment: result.payment,
        estimatedCrypto: result.estimatedCrypto ?? 0,
        destinationType: result.destinationType ?? 'kayspay_account',
        asset: result.asset ?? selectedBuyAsset,
        pendingSwap: !!result.pendingSwap,
      });
      setBuyStep('pick');
      setSelectedBuyAsset(null);
      setBuyUsdt('');
      setBuyDestAddress('');
      setBuyDestVerified(false);
      loadAll();
    } else {
      setActionError(result.error || 'Purchase failed. Please try again.');
      setActionState('failed');
    }
  }, [canBuy, selectedBuyAsset, numericBuyUsdt, buyToExternal, buyDestNetwork, buyDestAddress, authorize, loadAll, buyNgnEstimate]);

  const handleSell = useCallback(async () => {
    if (!canSell) return;
    const authResult = await authorize({ title: 'Confirm Crypto Sale', amount: sellNgnEstimate ?? undefined });
    if (!authResult) return;
    setActionAmountNgn(sellNgnEstimate);
    setActionState('processing');
    const result = await cryptoService.sell(numericSellUsdt, authResult.token);
    if (result.success) {
      setActionMessage(result.message ?? null);
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
      setActionMessage(result.message ?? null);
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

  const handleCopyBuyAccount = useCallback(async () => {
    if (!pendingBuyPayment) return;
    try {
      await Clipboard.setStringAsync(pendingBuyPayment.payment.accountNumber);
      Alert.alert('Copied', 'Account number copied.');
    } catch {
      Alert.alert('Copy account number', 'Could not copy the account number. Please try again.');
    }
  }, [pendingBuyPayment]);

  if (pendingBuyPayment) {
    const { payment, estimatedCrypto, destinationType, asset, pendingSwap } = pendingBuyPayment;
    return (
      <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
        <StatusBar barStyle="light-content" backgroundColor={DARK.void} />
        <View style={styles.topBar}>
          <TouchableOpacity style={styles.backButton} activeOpacity={0.6} onPress={() => setPendingBuyPayment(null)}>
            <Ionicons name="chevron-back" size={26} color={DARK.ink} />
          </TouchableOpacity>
          <Text style={styles.topTitle}>Complete your purchase</Text>
        </View>
        <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
          <View style={styles.confirmBox}>
            <Text style={styles.hintText}>Transfer exactly</Text>
            <Text style={styles.heroValue2}>{formatNaira(payment.amountToPay)}</Text>
            <View style={styles.payDetailRow}>
              <Text style={styles.payDetailLabel}>Bank</Text>
              <Text style={styles.payDetailValue}>{payment.bankName}</Text>
            </View>
            <View style={styles.payDetailRow}>
              <Text style={styles.payDetailLabel}>Account</Text>
              <Text style={styles.payDetailAccount}>{payment.accountNumber}</Text>
            </View>
            <View style={styles.payDetailRow}>
              <Text style={styles.payDetailLabel}>Name</Text>
              <Text style={styles.payDetailValue}>{payment.accountName}</Text>
            </View>
            <TouchableOpacity style={styles.copyAddressButton} onPress={handleCopyBuyAccount}>
              <Text style={styles.copyAddressButtonText}>Copy Account Number</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.feeBreakdown}>
            <View style={styles.payDetailRow}>
              <Text style={styles.feeLabel}>Purchase</Text>
              <Text style={styles.feeLabel}>{formatNaira(payment.amount)}</Text>
            </View>
            <View style={styles.payDetailRow}>
              <Text style={styles.feeLabel}>Processor fee</Text>
              <Text style={styles.feeLabel}>{formatNaira(payment.processorFee)}</Text>
            </View>
            <View style={styles.payDetailRow}>
              <Text style={styles.feeLabel}>VAT</Text>
              <Text style={styles.feeLabel}>{formatNaira(payment.vat)}</Text>
            </View>
            {payment.merchantMarkup > 0 && (
              <View style={styles.payDetailRow}>
                <Text style={styles.feeLabel}>Service fee</Text>
                <Text style={styles.feeLabel}>{formatNaira(payment.merchantMarkup)}</Text>
              </View>
            )}
          </View>

          <Text style={styles.hintText}>
            {pendingSwap
              ? `You'll receive about ${formatCoin(estimatedCrypto, asset)} into your KaysPay crypto account — first as USDT once the transfer clears, then automatically converted to ${asset}.`
              : `You'll receive about ${formatUsdt(estimatedCrypto)} into ${destinationType === 'external_wallet' ? 'your external wallet' : 'your KaysPay crypto account'} once the transfer clears.`}
          </Text>

          <View style={styles.confirmWarningBox}>
            <Text style={styles.confirmWarning}>
              Transfer from a bank account in your own name — Quidax rejects payments from a different name, and
              sending a different amount will delay it.
            </Text>
          </View>

          <TouchableOpacity style={styles.doneButtonOutline} onPress={() => setPendingBuyPayment(null)}>
            <Text style={styles.copyAddressButtonText}>Done — I'll transfer now</Text>
          </TouchableOpacity>
        </ScrollView>
      </SafeAreaView>
    );
  }

  if (actionState !== 'idle') {
    return (
      <ResultStatusView
        status={actionState}
        headerTitle="Crypto"
        amount={actionAmountNgn ?? undefined}
        message={actionState === 'failed' ? actionError : actionMessage ?? undefined}
        onDone={() => { setActionMessage(null); setActionState('idle'); }}
      />
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      <StatusBar barStyle="light-content" backgroundColor={DARK.void} />
      <View style={styles.topBar}>
        <TouchableOpacity style={styles.backButton} activeOpacity={0.6} onPress={() => navigation.goBack()}>
          <Ionicons name="chevron-back" size={26} color={DARK.ink} />
        </TouchableOpacity>
        <Text style={styles.topTitle}>Crypto</Text>
      </View>

      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'} showsVerticalScrollIndicator={false}>
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
              <TouchableOpacity key={t} style={styles.actionItem} onPress={() => handleSelectTab(t)} activeOpacity={0.75}>
                <View style={[styles.actionIcon, tab === t && styles.actionIconActive]}>
                  <Ionicons name={TAB_ICONS[t]} size={20} color={DARK.brand} />
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
                      <ActivityIndicator color={DARK.void} />
                    ) : (
                      <Text style={styles.primaryButtonText}>Generate Deposit Address</Text>
                    )}
                  </TouchableOpacity>
                )}
                {depositError && <Text style={styles.errorText}>{depositError}</Text>}
              </View>
            )}

            {tab === 'buy' && buyStep === 'pick' && (
              <View>
                <Text style={styles.hintText}>Pick a coin — live prices from Quidax's own market.</Text>
                {marketsLoading && markets.length === 0 ? (
                  <ActivityIndicator color={DARK.brand} style={{ marginTop: Spacing.L }} />
                ) : (
                  <View style={styles.coinList}>
                    {markets.map((m) => (
                      <TouchableOpacity
                        key={m.code}
                        style={styles.coinRow}
                        onPress={() => handlePickBuyAsset(m.code)}
                        activeOpacity={0.7}
                      >
                        <View style={styles.coinIcon}>
                          <Text style={styles.coinIconText}>{m.code.slice(0, 1)}</Text>
                        </View>
                        <View style={styles.coinMid}>
                          <Text style={styles.coinName}>{m.name}</Text>
                          <Text style={styles.coinTicker}>{m.code}{m.stablecoin ? ' · Stablecoin' : ''}</Text>
                        </View>
                        <View style={styles.coinRight}>
                          <Text style={styles.coinPrice}>{formatNaira(m.priceNgn)}</Text>
                          {m.change24hPct != null && (
                            <Text style={[styles.coinChange, { color: m.change24hPct >= 0 ? DARK.up : DARK.down }]}>
                              {m.change24hPct >= 0 ? '+' : ''}{m.change24hPct.toFixed(2)}%
                            </Text>
                          )}
                        </View>
                      </TouchableOpacity>
                    ))}
                    {!marketsLoading && markets.length === 0 && (
                      <Text style={styles.errorText}>Could not load live prices. Pull down to try again.</Text>
                    )}
                  </View>
                )}
              </View>
            )}

            {tab === 'buy' && buyStep === 'amount' && selectedBuyAsset && (
              <View>
                <TouchableOpacity style={styles.backLink} onPress={() => setBuyStep('pick')}>
                  <Ionicons name="chevron-back" size={16} color={DARK.inkFaint} />
                  <Text style={styles.backLinkText}>Change coin</Text>
                </TouchableOpacity>

                <View style={styles.coinSummaryRow}>
                  <View style={styles.coinIcon}><Text style={styles.coinIconText}>{selectedBuyAsset.slice(0, 1)}</Text></View>
                  <View>
                    <Text style={styles.coinName}>{selectedMarket?.name ?? selectedBuyAsset}</Text>
                    {selectedMarket && <Text style={styles.coinTicker}>{formatNaira(selectedMarket.priceNgn)}</Text>}
                  </View>
                </View>

                <Text style={styles.label}>Amount to spend (USDT)</Text>
                <TextInput
                  style={styles.input}
                  value={buyUsdt}
                  onChangeText={(t) => setBuyUsdt(t.replace(/[^0-9.]/g, ''))}
                  placeholder="e.g. 50"
                  placeholderTextColor={DARK.inkFaint}
                  keyboardType="decimal-pad"
                  autoFocus
                />
                {buyNgnEstimate != null && (
                  <Text style={styles.estimateText}>
                    ≈ {formatNaira(buyNgnEstimate)}
                    {buyCoinEstimate != null ? ` · ${formatCoin(buyCoinEstimate, selectedBuyAsset)}` : ''}
                  </Text>
                )}

                <TouchableOpacity
                  style={[styles.primaryButton, !canBuy && styles.primaryButtonDisabled]}
                  onPress={() => setBuyStep('review')}
                  disabled={!canBuy}
                >
                  <Text style={styles.primaryButtonText}>Review Purchase</Text>
                </TouchableOpacity>
              </View>
            )}

            {tab === 'buy' && buyStep === 'review' && selectedBuyAsset && (
              <View>
                <TouchableOpacity style={styles.backLink} onPress={() => setBuyStep('amount')}>
                  <Ionicons name="chevron-back" size={16} color={DARK.inkFaint} />
                  <Text style={styles.backLinkText}>Edit amount</Text>
                </TouchableOpacity>

                <Text style={styles.hintText}>You'll receive — estimated</Text>
                <Text style={styles.reviewBig}>
                  {selectedMarket?.stablecoin
                    ? formatUsdt(numericBuyUsdt || 0)
                    : buyCoinEstimate != null ? formatCoin(buyCoinEstimate, selectedBuyAsset) : '—'}
                </Text>

                <View style={styles.feeBreakdown}>
                  <View style={styles.payDetailRow}>
                    <Text style={styles.feeLabel}>Pay (budget)</Text>
                    <Text style={styles.feeLabel}>{formatUsdt(numericBuyUsdt || 0)}</Text>
                  </View>
                  {selectedMarket && !selectedMarket.stablecoin && (
                    <View style={styles.payDetailRow}>
                      <Text style={styles.feeLabel}>Rate</Text>
                      <Text style={styles.feeLabel}>1 {selectedBuyAsset} = {formatNaira(selectedMarket.priceNgn)}</Text>
                    </View>
                  )}
                  <View style={styles.payDetailRow}>
                    <Text style={styles.feeLabel}>Naira equivalent</Text>
                    <Text style={styles.feeLabel}>{buyNgnEstimate != null ? formatNaira(buyNgnEstimate) : '—'}</Text>
                  </View>
                </View>

                {!selectedMarket?.stablecoin && (
                  <View style={styles.confirmBox}>
                    <Text style={styles.confirmText}>
                      Delivered to your KaysPay crypto account. Rate is re-quoted the moment your transfer clears and
                      the conversion to {selectedBuyAsset} executes — the final amount may differ slightly from this estimate.
                    </Text>
                  </View>
                )}

                {selectedMarket?.stablecoin ? (
                  <TouchableOpacity style={styles.primaryButton} onPress={() => setBuyStep('destination')}>
                    <Text style={styles.primaryButtonText}>Continue</Text>
                  </TouchableOpacity>
                ) : (
                  <TouchableOpacity
                    style={[styles.primaryButton, (!canBuy || buyLoading) && styles.primaryButtonDisabled]}
                    onPress={handleBuy}
                    disabled={!canBuy || buyLoading}
                  >
                    {buyLoading ? <ActivityIndicator color={DARK.void} /> : <Text style={styles.primaryButtonText}>Confirm & Pay</Text>}
                  </TouchableOpacity>
                )}
              </View>
            )}

            {tab === 'buy' && buyStep === 'destination' && selectedBuyAsset && (
              <View>
                <TouchableOpacity style={styles.backLink} onPress={() => setBuyStep('review')}>
                  <Ionicons name="chevron-back" size={16} color={DARK.inkFaint} />
                  <Text style={styles.backLinkText}>Back to review</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.destinationToggleRow}
                  onPress={() => setBuyToExternal((v) => !v)}
                  activeOpacity={0.75}
                >
                  <View style={[styles.checkbox, buyToExternal && styles.checkboxChecked]}>
                    {buyToExternal && <Text style={styles.checkboxMark}>✓</Text>}
                  </View>
                  <Text style={styles.checkLabel}>Send to a different wallet instead of my crypto account</Text>
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
                      placeholderTextColor={DARK.inkFaint}
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

                <TouchableOpacity
                  style={[styles.primaryButton, (!canBuy || buyLoading) && styles.primaryButtonDisabled]}
                  onPress={handleBuy}
                  disabled={!canBuy || buyLoading}
                >
                  {buyLoading ? (
                    <ActivityIndicator color={DARK.void} />
                  ) : (
                    <Text style={styles.primaryButtonText}>Confirm & Pay</Text>
                  )}
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
                  placeholderTextColor={DARK.inkFaint}
                  keyboardType="decimal-pad"
                />
                {sellNgnEstimate != null && (
                  <Text style={styles.estimateText}>≈ {formatNaira(sellNgnEstimate)}</Text>
                )}
                {quidaxUsdtBalance != null && numericSellUsdt > quidaxUsdtBalance && (
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
                  Sends the USDT held in your crypto account to any external wallet. Network fees are deducted by the
                  network itself.
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
                  placeholderTextColor={DARK.inkFaint}
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
                  placeholderTextColor={DARK.inkFaint}
                  keyboardType="decimal-pad"
                />
                {quidaxUsdtBalance != null && numericWdAmount > quidaxUsdtBalance && (
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

const MONO = Platform.select({ ios: 'Courier', android: 'monospace', default: 'monospace' });

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: DARK.void },
  flex: { flex: 1 },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.SCREEN_PADDING,
    paddingTop: Spacing.S,
    paddingBottom: Spacing.S,
  },
  backButton: { width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
  topTitle: { ...Typography.SECTION_HEADING, color: DARK.ink, marginLeft: Spacing.S },
  scrollContent: { paddingHorizontal: Spacing.SCREEN_PADDING, paddingBottom: 60 },

  hero: {
    backgroundColor: HERO_BG,
    borderRadius: Spacing.CARD_RADIUS,
    padding: Spacing.CARD_PADDING,
    marginTop: Spacing.S,
    marginBottom: Spacing.L,
    borderWidth: 1,
    borderColor: DARK.hairline,
  },
  heroLabel: { ...Typography.CAPTION, color: HERO_TEXT_MUTED, marginBottom: Spacing.XS },
  heroValue: { fontFamily: MONO, fontSize: 28, fontWeight: '600', color: DARK.ink, marginBottom: Spacing.S },
  heroSub: { ...Typography.CAPTION, color: HERO_TEXT_MUTED },
  heroError: { ...Typography.CAPTION, color: HERO_ERROR },
  heroLegacy: { ...Typography.CAPTION, color: HERO_TEXT_MUTED, marginTop: Spacing.XS },

  actionsRow: { flexDirection: 'row', justifyContent: 'space-around', paddingBottom: Spacing.L },
  actionItem: { alignItems: 'center', minWidth: 64 },
  actionIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: DARK.surface,
    borderWidth: 1,
    borderColor: DARK.hairline,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: Spacing.XS,
  },
  actionIconActive: { borderWidth: 1.5, borderColor: DARK.brand, backgroundColor: DARK.brandSoft },
  actionLabel: { ...Typography.CAPTION, color: DARK.inkFaint },
  actionLabelActive: { color: DARK.brand, fontWeight: '700' },

  panel: {
    backgroundColor: DARK.surface,
    borderRadius: Spacing.CARD_RADIUS,
    borderWidth: 1,
    borderColor: DARK.hairline,
    padding: Spacing.CARD_PADDING,
  },
  label: { ...Typography.SECTION_HEADING, color: DARK.ink, marginTop: Spacing.M, marginBottom: Spacing.M },
  input: {
    height: Spacing.INPUT_HEIGHT,
    borderWidth: Spacing.INPUT_BORDER_WIDTH,
    borderColor: DARK.hairline,
    backgroundColor: DARK.raised,
    borderRadius: Spacing.BUTTON_RADIUS,
    paddingHorizontal: Spacing.L,
    ...Typography.BODY,
    color: DARK.ink,
  },
  estimateText: { ...Typography.BODY, fontFamily: MONO, color: DARK.brand, fontWeight: '700', marginTop: Spacing.S },
  errorText: { ...Typography.ERROR, color: DARK.down, marginTop: Spacing.S },
  hintText: { ...Typography.CAPTION, color: DARK.inkMuted, marginTop: Spacing.M },
  notLiveBanner: {
    ...Typography.CAPTION,
    color: DARK.brand,
    backgroundColor: DARK.brandSoft,
    borderRadius: Spacing.CARD_RADIUS,
    padding: Spacing.M,
    marginBottom: Spacing.L,
  },

  primaryButton: {
    height: Spacing.BUTTON_HEIGHT_PRIMARY,
    backgroundColor: DARK.brand,
    borderRadius: Spacing.BUTTON_RADIUS,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: Spacing.L,
  },
  primaryButtonDisabled: { opacity: 0.4 },
  primaryButtonText: { ...Typography.BUTTON_TEXT, color: DARK.void },

  savedRow: {
    borderWidth: 1,
    borderColor: DARK.hairline,
    backgroundColor: DARK.raised,
    borderRadius: Spacing.CARD_RADIUS,
    padding: Spacing.M,
    marginBottom: Spacing.S,
  },
  savedRowText: { ...Typography.BODY, color: DARK.ink },

  networkRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.S },
  networkChip: {
    paddingHorizontal: Spacing.M,
    paddingVertical: Spacing.S,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: DARK.hairline,
  },
  networkChipSelected: { backgroundColor: DARK.brandSoft, borderColor: DARK.brand },
  networkChipText: { ...Typography.CAPTION, color: DARK.inkMuted, fontWeight: '600' },
  networkChipTextSelected: { color: DARK.brand },

  qrCard: {
    alignSelf: 'center',
    backgroundColor: DARK.ink,
    borderWidth: 1,
    borderColor: DARK.hairline,
    borderRadius: 12,
    padding: Spacing.M,
    marginBottom: Spacing.M,
  },
  depositAddressText: { ...Typography.BODY, fontFamily: MONO, color: DARK.ink, textAlign: 'center', marginBottom: Spacing.M },
  copyAddressButton: {
    height: Spacing.BUTTON_HEIGHT_PRIMARY,
    borderRadius: Spacing.BUTTON_RADIUS,
    borderWidth: 1,
    borderColor: DARK.brand,
    justifyContent: 'center',
    alignItems: 'center',
  },
  copyAddressButtonText: { ...Typography.BUTTON_TEXT, color: DARK.brand },

  confirmBox: {
    backgroundColor: DARK.raised,
    borderWidth: 1,
    borderColor: DARK.hairline,
    borderRadius: Spacing.CARD_RADIUS,
    padding: Spacing.CARD_PADDING,
    marginTop: Spacing.L,
  },
  confirmText: { ...Typography.BODY, color: DARK.ink },
  confirmWarning: { ...Typography.CAPTION, color: DARK.gold, marginTop: Spacing.S },
  checkRow: { flexDirection: 'row', alignItems: 'center', marginTop: Spacing.M },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: DARK.brand,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: Spacing.M,
  },
  checkboxChecked: { backgroundColor: DARK.brand },
  checkboxMark: { color: DARK.void, fontSize: 14, fontWeight: '700' },
  checkLabel: { ...Typography.CAPTION, color: DARK.ink, flex: 1 },

  destinationToggleRow: { flexDirection: 'row', alignItems: 'center', marginTop: Spacing.L },

  heroValue2: { fontFamily: MONO, fontSize: 26, fontWeight: '600', color: DARK.ink, marginTop: Spacing.XS, marginBottom: Spacing.M },
  payDetailRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: Spacing.XS },
  payDetailLabel: { ...Typography.CAPTION, color: DARK.inkFaint },
  payDetailValue: { ...Typography.BODY, color: DARK.ink, fontWeight: '600' },
  payDetailAccount: { ...Typography.BODY, fontFamily: MONO, color: DARK.brand, fontWeight: '700', letterSpacing: 1 },
  feeBreakdown: { marginTop: Spacing.M, paddingHorizontal: Spacing.XS },
  feeLabel: { ...Typography.CAPTION, fontFamily: MONO, color: DARK.inkMuted },
  confirmWarningBox: {
    backgroundColor: DARK.errorBg,
    borderRadius: Spacing.CARD_RADIUS,
    padding: Spacing.M,
    marginTop: Spacing.L,
  },
  doneButtonOutline: {
    height: Spacing.BUTTON_HEIGHT_PRIMARY,
    borderRadius: Spacing.BUTTON_RADIUS,
    borderWidth: 1,
    borderColor: DARK.brand,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: Spacing.L,
    marginBottom: Spacing.XL,
  },

  coinList: { gap: Spacing.XS, marginTop: Spacing.M },
  coinRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: Spacing.M,
    borderBottomWidth: 1,
    borderBottomColor: DARK.hairlineSoft,
  },
  coinIcon: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: DARK.raised2,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: Spacing.M,
  },
  coinIconText: { ...Typography.BODY, fontFamily: MONO, color: DARK.brand, fontWeight: '700' },
  coinMid: { flex: 1 },
  coinName: { ...Typography.BODY, color: DARK.ink, fontWeight: '600' },
  coinTicker: { ...Typography.CAPTION, color: DARK.inkFaint, marginTop: 2 },
  coinRight: { alignItems: 'flex-end' },
  coinPrice: { ...Typography.BODY, fontFamily: MONO, color: DARK.ink, fontWeight: '600' },
  coinChange: { ...Typography.CAPTION, fontFamily: MONO, fontWeight: '600', marginTop: 2 },

  backLink: { flexDirection: 'row', alignItems: 'center', marginBottom: Spacing.M },
  backLinkText: { ...Typography.CAPTION, color: DARK.inkFaint, marginLeft: 2 },

  coinSummaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: DARK.raised,
    borderWidth: 1,
    borderColor: DARK.hairline,
    borderRadius: Spacing.CARD_RADIUS,
    padding: Spacing.M,
    marginBottom: Spacing.L,
  },
  reviewBig: {
    fontFamily: MONO,
    fontSize: 30,
    fontWeight: '700',
    color: DARK.ink,
    marginTop: Spacing.S,
    marginBottom: Spacing.M,
  },
});
