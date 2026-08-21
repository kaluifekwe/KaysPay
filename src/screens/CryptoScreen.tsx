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
  Platform,
  StatusBar,
  Modal,
  FlatList,
  Image,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-aware-scroll-view';
import { Ionicons } from '@expo/vector-icons';
import { Typography } from '../constants/typography';
import { Spacing } from '../constants/spacing';
import { AppTheme } from '../constants/theme';
import { useTheme } from '../components/ThemeProvider';
import { formatNaira } from '../utils/formatCurrency';
import { storageHelpers, StorageKeys } from '../lib/mmkv';
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
import { kycService } from '../services/kyc.service';
import { useTransactionAuth } from '../components/TransactionAuthProvider';
import ProviderLogo from '../components/ProviderLogo';
import { CRYPTO_LOGOS } from '../utils/providerLogos';
import ResultStatusView, { type ResultStatus } from '../components/ResultStatusView';
import QrCodeView from '../components/QrCodeView';
import CryptoRefundBankModal from '../components/CryptoRefundBankModal';

interface CryptoScreenProps {
  navigation: { goBack: () => void; navigate: (screen: string, params?: any) => void };
}

type Tab = 'deposit' | 'buy' | 'sell' | 'withdraw';

// Display-only snapshot for instant paint on open — see the mount effect
// and loadAll() below. Never consulted by any balance check that actually
// gates a Buy/Sell/Withdraw, which always re-fetch live.
interface CryptoScreenCache {
  ngnBalance: number | null;
  usdtBalance: number | null;
  rate: number | null;
  buyRate: number | null;
  sellRate: number | null;
  quidaxWallets: QuidaxWalletBalance[];
}

// Crypto used to have its own permanently-dark, trading-terminal treatment;
// it now follows the app-wide theme toggle (Settings > Dark Mode) like every
// other screen — dark mode just happens to reuse the same palette this
// screen originally built for itself (see constants/theme.ts).

// The coin picker's "Popular" filter — a subset of the full curated list,
// not a separate data source. "All" always means the full 9 coins Buy
// actually supports (not Quidax's wider ~50-asset universe — this app only
// offers what it can actually deliver end to end).
const POPULAR_BUY_CODES: BuyAsset[] = ['USDT', 'BTC', 'ETH', 'SOL', 'XRP'];
type CoinFilter = 'popular' | 'gainers' | 'all';

// A tiny connected-line sparkline built from pure Views (no react-native-svg
// in this project — same constraint QrCodeView.tsx already works around).
// Quidax's ticker has no intraday tick history, only today's open/low/high/
// last, so this shapes an honest little trend line from those 4 real
// reference points rather than either omitting the chart or fabricating
// fake tick data to fill it.
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

// Not every bank in the list has a logo (the free public source only covers
// the major institutions) — falls back to a plain initial badge rather than
// a broken image, and to a real image if a fetched one fails to load.
function BankLogoIcon({ bank, size }: { bank: { name: string; logo?: string }; size: number }) {
  const { theme } = useTheme();
  const [failed, setFailed] = useState(false);
  const showImage = !!bank.logo && !failed;
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        overflow: 'hidden',
        backgroundColor: theme.surfaceRaised,
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: Spacing.S,
      }}
    >
      {showImage ? (
        <Image
          source={{ uri: bank.logo }}
          style={{ width: size, height: size }}
          resizeMode="contain"
          onError={() => setFailed(true)}
        />
      ) : (
        <Text style={{ ...Typography.CAPTION, color: theme.inkMuted, fontWeight: '700' }}>
          {bank.name.charAt(0).toUpperCase()}
        </Text>
      )}
    </View>
  );
}

export default function CryptoScreen({ navigation }: CryptoScreenProps) {
  const { authorize } = useTransactionAuth();
  const { theme } = useTheme();
  const styles = createStyles(theme);
  const insets = useSafeAreaInsets();

  const [tab, setTab] = useState<Tab>('deposit');
  // Buy/Sell require identity verification (NIN/BVN) — Deposit doesn't.
  // null = not checked yet, so the real Buy/Sell forms never flash on
  // screen before this resolves; the gate below only renders once it's
  // explicitly false. Re-checked on every focus so returning from the KYC
  // screen with a fresh verification unlocks the tab immediately.
  const [kycVerified, setKycVerified] = useState<boolean | null>(null);

  useFocusEffect(
    useCallback(() => {
      kycService.getStatus().then((s) => setKycVerified(s.verified)).catch(() => setKycVerified(false));
    }, []),
  );
  // Defense in depth for the admin's Crypto kill switch: Home already
  // removes the tile/advert entirely when this is off, so reaching this
  // screen at all should only happen via a stale nav stack — still checked
  // here so that path shows a clear message instead of a live trading UI
  // whose actions the server would reject anyway.
  const [serviceEnabled, setServiceEnabled] = useState(true);

  useFocusEffect(
    useCallback(() => {
      cryptoService.isEnabled().then(setServiceEnabled).catch(() => {});
    }, []),
  );
  // Shares the same StorageKeys.BALANCE_VISIBLE flag as the Home screen —
  // "hide my balance" is one app-wide privacy preference, not a per-screen one.
  const [balanceVisible, setBalanceVisible] = useState(true);
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
  const [buyStep, setBuyStep] = useState<'pick' | 'amount' | 'destination'>('pick');
  const [markets, setMarkets] = useState<MarketCoin[]>([]);
  const [marketsLoading, setMarketsLoading] = useState(false);
  const [coinSearch, setCoinSearch] = useState('');
  const [coinFilter, setCoinFilter] = useState<CoinFilter>('popular');
  const [usdtNgnRate, setUsdtNgnRate] = useState<number | null>(null);
  // Shown on the amount screen before the customer commits — the exact
  // numbers crypto-buy itself enforces, so this can't promise something the
  // real purchase then rejects (or worse, silently accepts and gets stuck —
  // see the ₦2,790 purchase that hung forever below Quidax's real minimum).
  const [buyLimits, setBuyLimits] = useState<{ minNgn: number; maxNgn: number } | null>(null);
  const [selectedBuyAsset, setSelectedBuyAsset] = useState<BuyAsset | null>(null);
  const [buyNgn, setBuyNgn] = useState('');
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
    transactionId: string;
  } | null>(null);
  // Polling this order's status live after "Done — I'll transfer now", so the
  // purchase visibly lands instead of just going quiet until the screen is
  // manually reopened.
  const [buyPollTxId, setBuyPollTxId] = useState<string | null>(null);
  const [sellUsdt, setSellUsdt] = useState('');
  // Sell pays a bank account directly (off-ramp) — no separate verify step
  // for this first version; a name mismatch surfaces as an error after
  // tapping Sell, same as every other input on this screen already works.
  const [sellBanks, setSellBanks] = useState<{ code: string; name: string; logo?: string }[]>([]);
  const [sellBanksLoading, setSellBanksLoading] = useState(false);
  const [sellBankPickerVisible, setSellBankPickerVisible] = useState(false);
  const [sellBankSearch, setSellBankSearch] = useState('');
  const [sellBank, setSellBank] = useState<{ code: string; name: string; logo?: string } | null>(null);
  const [sellAccountNumber, setSellAccountNumber] = useState('');
  const [sellVerifyState, setSellVerifyState] = useState<'idle' | 'checking' | 'verified' | 'failed'>('idle');
  const [sellVerifiedName, setSellVerifiedName] = useState<string | null>(null);
  const [sellVerifyError, setSellVerifyError] = useState<string | null>(null);

  const [wdNetwork, setWdNetwork] = useState<CryptoNetwork>('TRC20');
  const [wdAddress, setWdAddress] = useState('');
  const [wdAmount, setWdAmount] = useState('');
  const [wdVerified, setWdVerified] = useState(false);
  const [savedAddresses, setSavedAddresses] = useState<SavedCryptoAddress[]>([]);

  // A Buy Quidax auto-refunded (paying account name didn't match) and is
  // waiting on the customer's own bank details — see CryptoRefundBankModal.
  const [pendingRefund, setPendingRefund] = useState<{ transactionId: string; amountNgn: number } | null>(null);
  const [refundModalVisible, setRefundModalVisible] = useState(false);

  const loadAll = useCallback(async () => {
    const [walletResult, usdt, liveRate, saved, quidaxAccount, refund] = await Promise.all([
      walletService.getWallet(),
      cryptoService.getBalance('USDT'),
      cryptoService.getQuoteRate(),
      cryptoService.listSavedAddresses('USDT'),
      cryptoService.getOrCreateAccount(),
      cryptoService.getPendingBuyRefund(),
    ]);
    const freshNgnBalance = walletResult.success && walletResult.wallet ? walletResult.wallet.available_balance : null;
    if (freshNgnBalance != null) setNgnBalance(freshNgnBalance);
    setUsdtBalance(usdt);
    setRate(liveRate?.rate ?? null);
    setBuyRate(liveRate?.buyRate ?? null);
    setSellRate(liveRate?.sellRate ?? null);
    setSavedAddresses(saved);
    setPendingRefund(refund);
    if (quidaxAccount.success) {
      setQuidaxWallets(quidaxAccount.wallets);
      setQuidaxLoadError(null);
      // Cache the fresh numbers for next time the screen opens — display
      // only, never consulted by any Buy/Sell/Withdraw balance check, which
      // always re-fetches live. A failed Quidax load (above) deliberately
      // does NOT overwrite the cache, so a transient error never replaces a
      // good last-known number with nothing.
      //
      // quidaxAccount.wallets holds 100+ currencies, almost all zero balance
      // (SecureStore caps an item at 2KB — the full list blows past that and
      // would silently fail to cache at all) — only the ones actually held
      // are ever shown anyway, so only those are worth caching.
      storageHelpers.setObject<CryptoScreenCache>(StorageKeys.CRYPTO_SCREEN_CACHE, {
        ngnBalance: freshNgnBalance,
        usdtBalance: usdt,
        rate: liveRate?.rate ?? null,
        buyRate: liveRate?.buyRate ?? null,
        sellRate: liveRate?.sellRate ?? null,
        quidaxWallets: quidaxAccount.wallets.filter((w) => Number(w.balance) > 0),
      });
    } else {
      setQuidaxLoadError(quidaxAccount.error || 'Could not load your crypto account.');
    }
  }, []);

  const loadMarkets = useCallback(async () => {
    setMarketsLoading(true);
    const result = await cryptoService.getMarkets();
    setMarketsLoading(false);
    if (result) {
      setMarkets(result.coins);
      setUsdtNgnRate(result.usdtNgnRate);
    }
  }, []);

  useEffect(() => {
    // Paints the screen with the last known numbers instantly (a fast local
    // read) while the real live fetch below runs in parallel — the live
    // result always wins once it lands, this is purely to avoid a blank
    // screen for the second or two Quidax's live balance/price calls take.
    storageHelpers.getObject<CryptoScreenCache>(StorageKeys.CRYPTO_SCREEN_CACHE).then((cached) => {
      if (!cached) return;
      if (cached.ngnBalance != null) setNgnBalance(cached.ngnBalance);
      if (cached.usdtBalance != null) setUsdtBalance(cached.usdtBalance);
      if (cached.rate != null) setRate(cached.rate);
      if (cached.buyRate != null) setBuyRate(cached.buyRate);
      if (cached.sellRate != null) setSellRate(cached.sellRate);
      if (cached.quidaxWallets) setQuidaxWallets(cached.quidaxWallets);
    });
    loadAll();
    // Prices are needed up front now too, to value every coin in the wallet
    // hero — not just once the customer opens Buy.
    loadMarkets();
    cryptoService.getBuyLimits().then((limits) => { if (limits) setBuyLimits(limits); });
    storageHelpers.getBoolean(StorageKeys.BALANCE_VISIBLE).then((v) => {
      if (v !== undefined) setBalanceVisible(v);
    });
  }, [loadAll, loadMarkets]);

  // Safety net: retry once if the customer opens Buy and the initial
  // markets fetch above happened to fail.
  useEffect(() => {
    if (tab === 'buy' && markets.length === 0 && !marketsLoading) {
      loadMarkets();
    }
  }, [tab, markets.length, marketsLoading, loadMarkets]);

  const toggleBalanceVisibility = useCallback(() => {
    setBalanceVisible((prev) => {
      const next = !prev;
      storageHelpers.setBoolean(StorageKeys.BALANCE_VISIBLE, next);
      return next;
    });
  }, []);

  const handleSelectTab = useCallback((t: Tab) => {
    setTab(t);
    if (t === 'buy') {
      setBuyStep('pick');
      setSelectedBuyAsset(null);
      setBuyNgn('');
      setBuyToExternal(false);
    }
  }, []);

  const handlePickBuyAsset = useCallback((code: BuyAsset) => {
    setSelectedBuyAsset(code);
    setBuyNgn('');
    setBuyToExternal(false);
    setBuyStep('amount');
  }, []);

  const quidaxUsdt = quidaxWallets.find((w) => w.currency === 'USDT');
  // Sell and Withdraw both spend the real balance held in the user's own
  // Quidax sub-account — never the legacy `usdtBalance` ledger number,
  // which only backs the not-yet-migrated Buy flow.
  const quidaxUsdtBalance = quidaxUsdt ? Number(quidaxUsdt.balance) : null;

  // Every coin the wallet hero and asset list show — not just USDT.
  const heldWallets = quidaxWallets.filter((w) => Number(w.balance) > 0);
  const priceOfNgn = useCallback(
    (currency: string): number | null => {
      if (currency === 'USDT') return usdtNgnRate ?? rate ?? null;
      const market = markets.find((m) => m.code === currency);
      return market && market.priceNgn > 0 ? market.priceNgn : null;
    },
    [markets, usdtNgnRate, rate],
  );
  const totalCryptoNgn = heldWallets.reduce((sum, w) => {
    const price = priceOfNgn(w.currency);
    return price ? sum + Number(w.balance) * price : sum;
  }, 0);
  const usdtRateForTotal = usdtNgnRate ?? rate ?? null;
  const totalCryptoUsdt = usdtRateForTotal && usdtRateForTotal > 0 ? totalCryptoNgn / usdtRateForTotal : null;
  // The live 1 USDT -> NGN quote shown under the hero total, same rate the
  // old "Deposited USDT" hero used to display.
  const liveUsdtRate = rate ?? usdtNgnRate ?? null;
  const heroUsdtDisplay = heldWallets.length === 0
    ? formatUsdt(0)
    : totalCryptoUsdt != null
      ? formatUsdt(totalCryptoUsdt)
      : '—';

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

  useEffect(() => {
    if (tab !== 'sell' || sellBanks.length > 0 || sellBanksLoading) return;
    setSellBanksLoading(true);
    cryptoService.listSellBanks().then((list) => {
      setSellBanksLoading(false);
      setSellBanks(list);
    });
  }, [tab, sellBanks.length, sellBanksLoading]);

  const numericBuyNgn = parseFloat(buyNgn);
  const numericSellUsdt = parseFloat(sellUsdt);
  const numericWdAmount = parseFloat(wdAmount);

  // Resets whenever any input the verification depended on changes — a
  // verified checkmark must never survive an edit to the amount, bank, or
  // account number it was verified against.
  useEffect(() => {
    setSellVerifyState('idle');
    setSellVerifiedName(null);
    setSellVerifyError(null);
  }, [sellUsdt, sellBank, sellAccountNumber]);

  useEffect(() => {
    if (!sellBank || sellAccountNumber.length !== 10 || !(numericSellUsdt > 0)) return;
    const handle = setTimeout(async () => {
      setSellVerifyState('checking');
      const res = await cryptoService.resolveSellAccount(numericSellUsdt, sellBank.code, sellAccountNumber);
      setSellVerifyState((current) => {
        if (current !== 'checking') return current;
        return res.success ? 'verified' : 'failed';
      });
      if (res.success) {
        setSellVerifiedName(res.accountName || null);
      } else {
        setSellVerifyError(res.error || 'Could not verify this account.');
      }
    }, 700);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sellBank, sellAccountNumber, numericSellUsdt]);

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
  // NGN is what the customer actually types (they're paying by bank
  // transfer in Naira). Deliberately NO pre-purchase crypto-amount estimate
  // anywhere in Buy any more — the exchange ticker one shown here used to
  // run far off Ramp's real rate (a genuine ₦3,000 purchase settled at
  // ~1.1462 USDT; the old formula showed ~2.15208 for the same amount), and
  // Ramp's own purchase_quotes/buy endpoint 404s regardless of the request
  // shape tried. Rather than show a number that might be wrong, the first
  // crypto amount shown anywhere is the real one, once Quidax prices the
  // purchase — see the "Complete your purchase" screen, which has been
  // accurate on every real purchase made this session.
  const sellNgnEstimate = sellRate && numericSellUsdt > 0 ? numericSellUsdt * sellRate : null;

  const wdAddressValid = wdAddress.trim().length > 0 && isValidCryptoAddress(wdNetwork, wdAddress);
  const wdAddressError = wdAddress.trim().length > 0 && !wdAddressValid
    ? `This doesn't look like a valid ${wdNetwork} address.`
    : null;

  const buyDestAddressValid = buyDestAddress.trim().length > 0 && isValidCryptoAddress(buyDestNetwork, buyDestAddress);
  const buyDestAddressError = buyDestAddress.trim().length > 0 && !buyDestAddressValid
    ? `This doesn't look like a valid ${buyDestNetwork} address.`
    : null;

  const buyBelowMin = buyLimits != null && numericBuyNgn > 0 && numericBuyNgn < buyLimits.minNgn;
  const buyAboveMax = buyLimits != null && numericBuyNgn > 0 && numericBuyNgn > buyLimits.maxNgn;
  const canBuy = !!selectedBuyAsset && Number.isFinite(numericBuyNgn) && numericBuyNgn > 0
    && !buyBelowMin && !buyAboveMax
    && (!buyToExternal || (buyDestAddressValid && buyDestVerified));
  const sellAccountNumberValid = /^\d{10}$/.test(sellAccountNumber);
  const canSell = Number.isFinite(numericSellUsdt) && numericSellUsdt >= 1 && numericSellUsdt <= 2000
    && quidaxUsdtBalance != null && numericSellUsdt <= quidaxUsdtBalance
    && !!sellBank && sellAccountNumberValid && sellVerifyState === 'verified';
  const canWithdraw = Number.isFinite(numericWdAmount) && numericWdAmount >= 5 && numericWdAmount <= 2000
    && quidaxUsdtBalance != null && numericWdAmount <= quidaxUsdtBalance && wdAddressValid && wdVerified;

  const handleBuy = useCallback(async () => {
    if (!canBuy || !selectedBuyAsset) return;
    const subtitle = buyToExternal
      ? `To ${buyDestNetwork} wallet ${buyDestAddress.trim()}`
      : 'To your KaysPay crypto account';
    const authResult = await authorize({
      title: `Confirm ${selectedBuyAsset} Purchase`,
      amount: numericBuyNgn || undefined,
      subtitle,
    });
    if (!authResult) return;
    setBuyLoading(true);
    const result = await cryptoService.buy(
      selectedBuyAsset,
      numericBuyNgn,
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
        transactionId: result.transactionId ?? '',
      });
      setBuyStep('pick');
      setSelectedBuyAsset(null);
      setBuyNgn('');
      setBuyDestAddress('');
      setBuyDestVerified(false);
      loadAll();
    } else {
      setActionError(result.error || 'Purchase failed. Please try again.');
      setActionState('failed');
    }
  }, [canBuy, selectedBuyAsset, numericBuyNgn, buyToExternal, buyDestNetwork, buyDestAddress, authorize, loadAll]);

  const handleSell = useCallback(async () => {
    if (!canSell || !sellBank) return;
    const authResult = await authorize({
      title: 'Confirm Crypto Sale',
      amount: sellNgnEstimate ?? undefined,
      subtitle: `${sellBank.name} · ${sellAccountNumber}`,
    });
    if (!authResult) return;
    setActionAmountNgn(sellNgnEstimate);
    setActionState('processing');
    const result = await cryptoService.sell(numericSellUsdt, sellBank.code, sellBank.name, sellAccountNumber, authResult.token);
    if (result.success) {
      setActionMessage(result.message ?? null);
      setActionState('success');
      setSellUsdt('');
      setSellBank(null);
      setSellAccountNumber('');
      loadAll();
    } else {
      setActionError(result.error || 'Sale failed. Please try again.');
      setActionState('failed');
    }
  }, [canSell, sellBank, sellAccountNumber, sellNgnEstimate, numericSellUsdt, authorize, loadAll]);

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

  // Polls the order live while the customer is on the processing screen, so
  // the purchase visibly lands the instant crypto-ramp-webhook (or the
  // reconcile sweep, as a fallback) settles it — not a fixed delay, a real
  // check every few seconds, starting immediately in case it already landed
  // by the time this screen appears.
  useEffect(() => {
    if (!buyPollTxId) return;
    let cancelled = false;
    let attempts = 0;
    const MAX_ATTEMPTS = 90; // ~6 minutes at 4s apart — generous for a bank transfer to clear

    const poll = async () => {
      if (cancelled) return;
      attempts++;
      const result = await cryptoService.getBuyOrderStatus(buyPollTxId);
      if (cancelled) return;

      if (result?.status === 'completed') {
        setActionMessage("Your crypto has landed — it's in your KaysPay account now.");
        setActionState('success');
        setBuyPollTxId(null);
        loadAll();
        return;
      }
      if (result?.needsRefundBankDetails) {
        // Quidax is auto-refunding this one (name mismatch) — hand off to
        // the banner/modal on the main screen rather than duplicating that
        // flow here.
        setActionState('idle');
        setBuyPollTxId(null);
        loadAll();
        return;
      }
      if (result?.status === 'failed') {
        setActionError(result.failureReason || 'This purchase could not be completed.');
        setActionState('failed');
        setBuyPollTxId(null);
        return;
      }
      if (attempts >= MAX_ATTEMPTS) {
        // Still pending after a generous wait — stop polling rather than
        // spin forever. Nothing is lost: the reconcile sweep and the push
        // notification trigger both still settle this independently.
        setActionMessage("This is taking longer than usual. We'll notify you the moment it's ready — no need to wait here.");
        setActionState('success');
        setBuyPollTxId(null);
        return;
      }
      setTimeout(poll, 4000);
    };
    poll();

    return () => { cancelled = true; };
  }, [buyPollTxId, loadAll]);

  const handleCopyBuyAccount = useCallback(async () => {
    if (!pendingBuyPayment) return;
    try {
      await Clipboard.setStringAsync(pendingBuyPayment.payment.accountNumber);
      Alert.alert('Copied', 'Account number copied.');
    } catch {
      Alert.alert('Copy account number', 'Could not copy the account number. Please try again.');
    }
  }, [pendingBuyPayment]);

  // Quidax's amount always carries a Kobo remainder (their flat processor
  // fee plus 7.5% VAT on it lands on exactly .50 every time) — not
  // something we can round away without the transfer no longer matching
  // what they're expecting. Copying it removes the actual friction (typing
  // it by hand) without touching the number itself.
  const handleCopyBuyAmount = useCallback(async () => {
    if (!pendingBuyPayment) return;
    try {
      await Clipboard.setStringAsync(pendingBuyPayment.payment.amountToPay.toFixed(2));
      Alert.alert('Copied', 'Amount copied — paste it into your bank transfer.');
    } catch {
      Alert.alert('Copy amount', 'Could not copy the amount. Please try again.');
    }
  }, [pendingBuyPayment]);

  if (pendingBuyPayment) {
    const { payment, estimatedCrypto, destinationType, asset, pendingSwap } = pendingBuyPayment;
    return (
      <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
        <StatusBar barStyle={theme.mode === 'dark' ? 'light-content' : 'dark-content'} backgroundColor={theme.background} />
        <View style={styles.topBar}>
          <TouchableOpacity style={styles.backButton} activeOpacity={0.6} onPress={() => setPendingBuyPayment(null)}>
            <Ionicons name="chevron-back" size={26} color={theme.ink} />
          </TouchableOpacity>
          <Text style={styles.topTitle}>Complete your purchase</Text>
        </View>
        <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
          <View style={styles.confirmBox}>
            <Text style={styles.hintText}>Transfer exactly</Text>
            <TouchableOpacity onPress={handleCopyBuyAmount} activeOpacity={0.7}>
              <Text style={styles.heroValue2}>{formatNaira(payment.amountToPay)}</Text>
              <Text style={styles.tapToCopyHint}>Tap to copy</Text>
            </TouchableOpacity>
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
            <View style={[styles.payDetailRow, styles.receiveRow]}>
              <Text style={styles.receiveLabel}>You'll receive</Text>
              <Text style={styles.receiveValue}>
                {pendingSwap ? formatCoin(estimatedCrypto, asset) : formatUsdt(estimatedCrypto)}
              </Text>
            </View>
          </View>

          <Text style={styles.hintText}>
            {pendingSwap
              ? `Into your KaysPay crypto account — first as USDT once the transfer clears, then automatically converted to ${asset}.`
              : `Into ${destinationType === 'external_wallet' ? 'your external wallet' : 'your KaysPay crypto account'} once the transfer clears.`}
          </Text>

          <View style={styles.confirmWarningBox}>
            <Text style={styles.confirmWarning}>
              Transfer from a bank account in your own name — payments from a different name will be rejected, and
              sending a different amount will delay it.
            </Text>
          </View>

          <TouchableOpacity
            style={styles.doneButtonOutline}
            onPress={() => {
              const txId = pendingBuyPayment?.transactionId;
              setPendingBuyPayment(null);
              if (txId) {
                setActionAmountNgn(payment.amount);
                setActionMessage("We're watching for your transfer — this updates automatically.");
                setActionState('processing');
                setBuyPollTxId(txId);
              }
            }}
          >
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
        processingHint={buyPollTxId ? 'Checking for your transfer…' : undefined}
        onDone={() => { setActionMessage(null); setActionState('idle'); setBuyPollTxId(null); }}
      >
        {actionState === 'processing' && buyPollTxId ? (
          <TouchableOpacity
            onPress={() => {
              setActionMessage("We'll notify you the moment it's ready.");
              setActionState('success');
              setBuyPollTxId(null);
            }}
            style={{ marginTop: Spacing.L }}
          >
            <Text style={{ color: theme.brand, fontWeight: '600' }}>Check back later</Text>
          </TouchableOpacity>
        ) : null}
      </ResultStatusView>
    );
  }

  if (!serviceEnabled) {
    return (
      <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
        <StatusBar barStyle={theme.mode === 'dark' ? 'light-content' : 'dark-content'} backgroundColor={theme.background} />
        <View style={styles.topBar}>
          <TouchableOpacity style={styles.backButton} activeOpacity={0.6} onPress={() => navigation.goBack()}>
            <Ionicons name="chevron-back" size={26} color={theme.ink} />
          </TouchableOpacity>
          <Text style={styles.topTitle}>Crypto</Text>
        </View>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: Spacing.L }}>
          <Ionicons name="logo-bitcoin" size={40} color={theme.inkFaint} />
          <Text style={{ ...Typography.CARD_TITLE, color: theme.ink, marginTop: Spacing.M, textAlign: 'center' }}>
            Crypto is currently unavailable
          </Text>
          <Text style={{ ...Typography.BODY, color: theme.inkMuted, marginTop: Spacing.S, textAlign: 'center' }}>
            We'll let you know as soon as it's back.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      <StatusBar barStyle={theme.mode === 'dark' ? 'light-content' : 'dark-content'} backgroundColor={theme.background} />
      <View style={styles.topBar}>
        <TouchableOpacity style={styles.backButton} activeOpacity={0.6} onPress={() => navigation.goBack()}>
          <Ionicons name="chevron-back" size={26} color={theme.ink} />
        </TouchableOpacity>
        <Text style={styles.topTitle}>Crypto</Text>
      </View>

      <KeyboardAwareScrollView
        style={styles.flex}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        showsVerticalScrollIndicator={false}
        enableOnAndroid
        extraScrollHeight={20}
      >
          {pendingRefund && (
            <TouchableOpacity
              style={styles.refundBanner}
              onPress={() => setRefundModalVisible(true)}
              activeOpacity={0.8}
            >
              <Ionicons name="alert-circle" size={20} color={theme.gold} />
              <View style={styles.refundBannerTextWrap}>
                <Text style={styles.refundBannerTitle}>Refund needs your bank details</Text>
                <Text style={styles.refundBannerSub}>Tap to provide where we should send {formatNaira(pendingRefund.amountNgn)}</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={theme.inkFaint} />
            </TouchableOpacity>
          )}

          <View style={styles.hero}>
            <View style={styles.heroTop}>
              <Text style={styles.heroLabel}>Total Crypto Balance</Text>
              <TouchableOpacity
                style={styles.eyeButton}
                onPress={toggleBalanceVisibility}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Ionicons name={balanceVisible ? 'eye-outline' : 'eye-off-outline'} size={15} color="#FFFFFF" />
              </TouchableOpacity>
            </View>

            {quidaxLoadError ? (
              <>
                <Text style={styles.heroValue}>—</Text>
                <Text style={styles.heroError}>{quidaxLoadError}</Text>
              </>
            ) : (
              <>
                <Text style={styles.heroValue}>
                  {!balanceVisible && heroUsdtDisplay !== '—' ? '•••• USDT' : heroUsdtDisplay}
                </Text>
                <Text style={styles.heroSub}>
                  {heldWallets.length > 0
                    ? `${balanceVisible ? `≈ ${formatNaira(totalCryptoNgn)}` : '≈ ₦ ••••••'} across ${heldWallets.length} asset${heldWallets.length === 1 ? '' : 's'}`
                    : 'No crypto held yet — buy your first coin below'}
                  {liveUsdtRate != null ? ` · 1 USDT ≈ ${formatNaira(liveUsdtRate)}` : ''}
                </Text>

                {heldWallets.length > 0 && (
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    style={styles.assetStrip}
                    contentContainerStyle={styles.assetStripContent}
                  >
                    {heldWallets.map((w) => (
                      <View key={w.currency} style={styles.assetChip}>
                        <ProviderLogo
                          source={CRYPTO_LOGOS[w.currency]}
                          fallbackLabel={w.currency}
                          fallbackColor={theme.brandDark}
                          size={20}
                        />
                        <Text style={styles.assetChipText}>
                          {balanceVisible ? formatCoin(Number(w.balance), w.currency) : `•••• ${w.currency}`}
                        </Text>
                      </View>
                    ))}
                  </ScrollView>
                )}
              </>
            )}

            {usdtBalance != null && usdtBalance > 0 && (
              <Text style={styles.heroLegacy}>
                + {balanceVisible ? formatUsdt(usdtBalance) : '•••• USDT'} from Buy (not yet deposited)
              </Text>
            )}
          </View>

          <View style={styles.nairaCard}>
            <View style={styles.nairaLeft}>
              <View style={styles.nairaIcon}>
                <Text style={styles.nairaIconText}>₦</Text>
              </View>
              <View>
                <Text style={styles.nairaName}>Naira Wallet</Text>
                <Text style={styles.nairaHint}>For funding your next Buy</Text>
              </View>
            </View>
            <Text style={styles.nairaValue}>
              {ngnBalance != null ? (balanceVisible ? formatNaira(ngnBalance) : '₦ ••••••') : '—'}
            </Text>
          </View>

          {heldWallets.length > 0 && (
            <View style={styles.assetsSection}>
              <View style={styles.assetsSectionTitleRow}>
                <Text style={styles.sectionLabel}>Your assets</Text>
                <Text style={styles.assetsCount}>{heldWallets.length} held</Text>
              </View>
              {heldWallets.map((w) => {
                const market = markets.find((m) => m.code === w.currency);
                const price = priceOfNgn(w.currency);
                const ngnValue = price != null ? Number(w.balance) * price : null;
                return (
                  <View key={w.currency} style={styles.assetRow}>
                    <View style={styles.assetRowLeft}>
                      <ProviderLogo
                        source={CRYPTO_LOGOS[w.currency]}
                        fallbackLabel={market?.name ?? w.currency}
                        fallbackColor={theme.brand}
                        size={36}
                      />
                      <View>
                        <Text style={styles.assetRowName}>{market?.name ?? w.currency}</Text>
                        <Text style={styles.assetRowAmt}>
                          {balanceVisible ? formatCoin(Number(w.balance), w.currency) : '••••'}
                        </Text>
                      </View>
                    </View>
                    <Text style={styles.assetRowValue}>
                      {balanceVisible ? (ngnValue != null ? formatNaira(ngnValue) : '—') : '₦ ••••••'}
                    </Text>
                  </View>
                );
              })}
            </View>
          )}

          <View style={styles.actionsRow}>
            {/* Withdraw (crypto -> external wallet) is parked (owner
                2026-08-20, see migration 141): Buy/Sell cover the core
                Naira<->crypto need, and external-wallet withdrawal is a
                narrower, lower-priority feature. The tab and its backend
                stay in the repo behind the 'crypto_withdraw' kill switch;
                add 'withdraw' back to this list if it's ever wanted again. */}
            {(['deposit', 'buy', 'sell'] as Tab[]).map((t) => (
              <TouchableOpacity key={t} style={styles.actionItem} onPress={() => handleSelectTab(t)} activeOpacity={0.75}>
                <View style={[styles.actionIcon, tab === t && styles.actionIconActive]}>
                  <Ionicons name={TAB_ICONS[t]} size={20} color={theme.brand} />
                </View>
                <Text style={[styles.actionLabel, tab === t && styles.actionLabelActive]}>{TAB_LABELS[t]}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <View style={styles.panel}>
            {(tab === 'buy' || tab === 'sell') && kycVerified === false && (
              <View style={styles.kycGate}>
                <View style={styles.kycGateIconWrap}>
                  <Ionicons name="shield-checkmark-outline" size={28} color={theme.brand} />
                </View>
                <Text style={styles.kycGateTitle}>Verify Your Identity</Text>
                <Text style={styles.kycGateSubtitle}>
                  Buying and selling crypto requires identity verification. Verify your NIN or BVN to
                  continue — it only takes a minute.
                </Text>
                <TouchableOpacity
                  style={styles.primaryButton}
                  onPress={() => navigation.navigate('Kyc', { requiredFor: 'buy or sell crypto' })}
                  activeOpacity={0.85}
                >
                  <Text style={styles.primaryButtonText}>Verify Now</Text>
                </TouchableOpacity>
              </View>
            )}

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
                      <ActivityIndicator color={theme.background} />
                    ) : (
                      <Text style={styles.primaryButtonText}>Generate Deposit Address</Text>
                    )}
                  </TouchableOpacity>
                )}
                {depositError && <Text style={styles.errorText}>{depositError}</Text>}
              </View>
            )}

            {tab === 'buy' && buyStep === 'pick' && kycVerified !== false && (
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

            {tab === 'buy' && buyStep === 'amount' && selectedBuyAsset && kycVerified !== false && (
              <View>
                <TouchableOpacity style={styles.backLink} onPress={() => setBuyStep('pick')}>
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
                  autoFocus
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

                <View style={styles.confirmBox}>
                  <Text style={styles.confirmText}>
                    Delivered to your KaysPay crypto account. The exact amount of {selectedBuyAsset} you receive is
                    confirmed on the next screen, once your transfer is priced.
                  </Text>
                </View>

                <TouchableOpacity
                  style={[styles.primaryButton, (!canBuy || buyLoading) && styles.primaryButtonDisabled]}
                  onPress={() => {
                    if (selectedMarket?.stablecoin) {
                      setBuyStep('destination');
                    } else {
                      handleBuy();
                    }
                  }}
                  disabled={!canBuy || buyLoading}
                >
                  {buyLoading ? (
                    <ActivityIndicator color={theme.background} />
                  ) : (
                    <Text style={styles.primaryButtonText}>{selectedMarket?.stablecoin ? 'Continue' : 'Buy Now'}</Text>
                  )}
                </TouchableOpacity>
              </View>
            )}

            {tab === 'buy' && buyStep === 'destination' && selectedBuyAsset && kycVerified !== false && (
              <View>
                <TouchableOpacity style={styles.backLink} onPress={() => setBuyStep('amount')}>
                  <Ionicons name="chevron-back" size={16} color={theme.inkFaint} />
                  <Text style={styles.backLinkText}>Edit amount</Text>
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

                <TouchableOpacity
                  style={[styles.primaryButton, (!canBuy || buyLoading) && styles.primaryButtonDisabled]}
                  onPress={handleBuy}
                  disabled={!canBuy || buyLoading}
                >
                  {buyLoading ? (
                    <ActivityIndicator color={theme.background} />
                  ) : (
                    <Text style={styles.primaryButtonText}>Confirm & Pay</Text>
                  )}
                </TouchableOpacity>
              </View>
            )}

            {tab === 'sell' && kycVerified !== false && (
              <View>
                <Text style={styles.label}>Amount (USDT)</Text>
                <TextInput
                  style={styles.input}
                  value={sellUsdt}
                  onChangeText={(t) => setSellUsdt(t.replace(/[^0-9.]/g, ''))}
                  placeholder="e.g. 10"
                  placeholderTextColor={theme.inkFaint}
                  keyboardType="decimal-pad"
                />
                {sellNgnEstimate != null && (
                  <Text style={styles.estimateText}>≈ {formatNaira(sellNgnEstimate)}</Text>
                )}
                {quidaxUsdtBalance != null && numericSellUsdt > quidaxUsdtBalance && (
                  <Text style={styles.errorText}>Insufficient USDT balance.</Text>
                )}

                <Text style={styles.label}>Bank</Text>
                <TouchableOpacity
                  style={styles.bankSelect}
                  onPress={() => setSellBankPickerVisible(true)}
                  activeOpacity={0.7}
                  disabled={sellBanksLoading}
                >
                  {sellBanksLoading ? (
                    <ActivityIndicator size="small" color={theme.inkMuted} />
                  ) : (
                    <View style={styles.bankSelectRow}>
                      {sellBank && <BankLogoIcon bank={sellBank} size={22} />}
                      <Text style={sellBank ? styles.bankSelectText : styles.bankSelectPlaceholder}>
                        {sellBank ? sellBank.name : 'Choose a bank'}
                      </Text>
                    </View>
                  )}
                </TouchableOpacity>

                <Text style={styles.label}>Account Number</Text>
                <TextInput
                  style={styles.input}
                  value={sellAccountNumber}
                  onChangeText={(t) => setSellAccountNumber(t.replace(/[^0-9]/g, '').slice(0, 10))}
                  placeholder="10-digit account number"
                  placeholderTextColor={theme.inkFaint}
                  keyboardType="number-pad"
                  maxLength={10}
                />
                {sellVerifyState === 'checking' && (
                  <View style={styles.verifyRow}>
                    <ActivityIndicator size="small" color={theme.inkMuted} />
                    <Text style={styles.verifyCheckingText}>Verifying account…</Text>
                  </View>
                )}
                {sellVerifyState === 'verified' && sellVerifiedName && (
                  <View style={styles.verifiedCard}>
                    <View style={styles.verifiedHeading}>
                      <View style={styles.verifiedIcon}>
                        <Ionicons name="checkmark" size={14} color="#FFFFFF" />
                      </View>
                      <Text style={styles.verifiedTitle}>Account verified</Text>
                    </View>
                    <Text style={styles.verifiedName}>{sellVerifiedName}</Text>
                  </View>
                )}
                {sellVerifyState === 'failed' && (
                  <Text style={styles.errorText}>{sellVerifyError || 'Could not verify this account.'}</Text>
                )}
                {sellVerifyState === 'idle' && (
                  <Text style={styles.hintText}>Must be an account in your own name.</Text>
                )}

                <TouchableOpacity
                  style={[styles.primaryButton, !canSell && styles.primaryButtonDisabled]}
                  onPress={handleSell}
                  disabled={!canSell}
                >
                  <Text style={styles.primaryButtonText}>Sell USDT</Text>
                </TouchableOpacity>
                <Text style={styles.hintText}>Paid straight to that bank account — your KaysPay wallet is not involved.</Text>
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
                  placeholderTextColor={theme.inkFaint}
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
                  placeholderTextColor={theme.inkFaint}
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
      </KeyboardAwareScrollView>

      {pendingRefund && (
        <CryptoRefundBankModal
          visible={refundModalVisible}
          transactionId={pendingRefund.transactionId}
          amountNgn={pendingRefund.amountNgn}
          onClose={() => setRefundModalVisible(false)}
          onSubmitted={() => {
            setPendingRefund(null);
            loadAll();
          }}
        />
      )}

      <Modal visible={sellBankPickerVisible} animationType="slide" onRequestClose={() => setSellBankPickerVisible(false)}>
        <SafeAreaView style={styles.container}>
          <View style={styles.header}>
            <Text style={styles.headerTitle}>Select Bank</Text>
            <TouchableOpacity onPress={() => setSellBankPickerVisible(false)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name="close" size={22} color={theme.ink} />
            </TouchableOpacity>
          </View>
          <TextInput
            style={styles.pickerSearch}
            value={sellBankSearch}
            onChangeText={setSellBankSearch}
            placeholder="Search bank..."
            placeholderTextColor={theme.inkMuted}
            autoFocus
          />
          <FlatList
            data={sellBanks.filter((b) => b.name.toLowerCase().includes(sellBankSearch.trim().toLowerCase()))}
            keyExtractor={(b) => b.code}
            renderItem={({ item }) => (
              <TouchableOpacity
                style={[styles.pickerRow, styles.pickerRowWithLogo]}
                activeOpacity={0.7}
                onPress={() => {
                  setSellBank(item);
                  setSellBankPickerVisible(false);
                  setSellBankSearch('');
                }}
              >
                <BankLogoIcon bank={item} size={28} />
                <Text style={styles.pickerRowText}>{item.name}</Text>
              </TouchableOpacity>
            )}
            ListEmptyComponent={<Text style={styles.pickerEmptyText}>No matching bank.</Text>}
            keyboardShouldPersistTaps="handled"
          />
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

const MONO = Platform.select({ ios: 'Courier', android: 'monospace', default: 'monospace' });

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.background },
  flex: { flex: 1 },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.SCREEN_PADDING,
    paddingTop: Spacing.S,
    paddingBottom: Spacing.S,
  },
  backButton: { width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
  topTitle: { ...Typography.SECTION_HEADING, color: theme.ink, marginLeft: Spacing.S },
  scrollContent: { paddingHorizontal: Spacing.SCREEN_PADDING, paddingBottom: 60 },

  refundBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.M,
    backgroundColor: theme.goldSoft,
    borderRadius: Spacing.CARD_RADIUS,
    padding: Spacing.M,
    marginTop: Spacing.S,
  },
  refundBannerTextWrap: { flex: 1 },
  refundBannerTitle: { ...Typography.BODY, fontWeight: '700', color: theme.ink },
  refundBannerSub: { ...Typography.CAPTION, color: theme.inkMuted, marginTop: 2 },

  // Fixed dark-green surface, independent of light/dark mode — theme.brandDark
  // is a dark tone in BOTH themes, so the hardcoded white text below always
  // has contrast, unlike theme.surfaceRaised which flips light/dark.
  hero: {
    backgroundColor: theme.brandDark,
    borderRadius: Spacing.CARD_RADIUS,
    padding: Spacing.CARD_PADDING,
    marginTop: Spacing.S,
    marginBottom: Spacing.M,
  },
  heroTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: Spacing.XS },
  heroLabel: { ...Typography.CAPTION, fontWeight: '700', letterSpacing: 0.3, color: 'rgba(255,255,255,0.72)' },
  eyeButton: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.14)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  heroValue: { fontFamily: MONO, fontSize: 28, fontWeight: '600', color: '#FFFFFF', marginBottom: Spacing.XS },
  heroSub: { ...Typography.CAPTION, color: 'rgba(255,255,255,0.68)', marginBottom: Spacing.M },
  heroError: { ...Typography.CAPTION, color: '#FFB4B4' },
  heroLegacy: { ...Typography.CAPTION, color: 'rgba(255,255,255,0.68)', marginTop: Spacing.M },

  assetStrip: { marginHorizontal: -2 },
  assetStripContent: { gap: Spacing.S, paddingRight: Spacing.S },
  assetChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderRadius: 20,
    paddingVertical: 5,
    paddingHorizontal: 10,
  },
  assetChipText: { ...Typography.CAPTION, fontFamily: MONO, fontWeight: '600', color: '#FFFFFF' },

  nairaCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.hairline,
    borderRadius: Spacing.CARD_RADIUS,
    padding: Spacing.CARD_PADDING,
    marginBottom: Spacing.L,
  },
  nairaLeft: { flexDirection: 'row', alignItems: 'center', gap: Spacing.M },
  nairaIcon: {
    width: 38,
    height: 38,
    borderRadius: 12,
    backgroundColor: theme.surfaceRaised,
    justifyContent: 'center',
    alignItems: 'center',
  },
  nairaIconText: { ...Typography.BODY, fontWeight: '800', color: theme.brand },
  nairaName: { ...Typography.BODY, color: theme.ink, fontWeight: '700' },
  nairaHint: { ...Typography.CAPTION, color: theme.inkFaint, marginTop: 2 },
  nairaValue: { ...Typography.BODY, fontFamily: MONO, fontWeight: '700', color: theme.ink },

  assetsSection: { marginBottom: Spacing.L },
  assetsSectionTitleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  assetsCount: { ...Typography.CAPTION, color: theme.inkFaint },
  assetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: Spacing.S,
    borderBottomWidth: 1,
    borderBottomColor: theme.hairlineSoft,
  },
  assetRowLeft: { flexDirection: 'row', alignItems: 'center', gap: Spacing.M },
  assetRowName: { ...Typography.BODY, color: theme.ink, fontWeight: '600' },
  assetRowAmt: { ...Typography.CAPTION, fontFamily: MONO, color: theme.inkFaint, marginTop: 2 },
  assetRowValue: { ...Typography.BODY, fontFamily: MONO, fontWeight: '700', color: theme.ink },

  actionsRow: { flexDirection: 'row', justifyContent: 'space-around', paddingBottom: Spacing.L },
  actionItem: { alignItems: 'center', minWidth: 64 },
  actionIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.hairline,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: Spacing.XS,
  },
  actionIconActive: { borderWidth: 1.5, borderColor: theme.brand, backgroundColor: theme.brandSoft },
  actionLabel: { ...Typography.CAPTION, color: theme.inkFaint },
  actionLabelActive: { color: theme.brand, fontWeight: '700' },

  panel: {
    backgroundColor: theme.surface,
    borderRadius: Spacing.CARD_RADIUS,
    borderWidth: 1,
    borderColor: theme.hairline,
    padding: Spacing.CARD_PADDING,
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
  estimateText: { ...Typography.BODY, fontFamily: MONO, color: theme.brand, fontWeight: '700', marginTop: Spacing.S },

  bankSelect: {
    height: Spacing.INPUT_HEIGHT,
    borderWidth: Spacing.INPUT_BORDER_WIDTH,
    borderColor: theme.hairline,
    backgroundColor: theme.surfaceRaised,
    borderRadius: Spacing.BUTTON_RADIUS,
    paddingHorizontal: Spacing.L,
    justifyContent: 'center',
  },
  bankSelectRow: { flexDirection: 'row', alignItems: 'center' },
  pickerRowWithLogo: { flexDirection: 'row', alignItems: 'center' },
  bankSelectText: { ...Typography.BODY, color: theme.ink },
  bankSelectPlaceholder: { ...Typography.BODY, color: theme.inkFaint },
  verifyRow: { flexDirection: 'row', alignItems: 'center', marginTop: Spacing.S },
  verifyCheckingText: { ...Typography.CAPTION, color: theme.inkMuted, marginLeft: Spacing.S },
  verifiedCard: {
    marginTop: Spacing.M,
    padding: Spacing.L,
    borderRadius: Spacing.CARD_RADIUS,
    backgroundColor: theme.brandSoft,
  },
  verifiedHeading: { flexDirection: 'row', alignItems: 'center', gap: Spacing.S },
  verifiedIcon: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.brand,
  },
  verifiedTitle: { ...Typography.CAPTION, color: theme.brand, fontWeight: '700' },
  verifiedName: { ...Typography.BODY, color: theme.ink, marginTop: Spacing.S },
  pickerSearch: {
    margin: Spacing.L,
    height: Spacing.INPUT_HEIGHT,
    borderWidth: Spacing.INPUT_BORDER_WIDTH,
    borderColor: theme.hairline,
    borderRadius: Spacing.BUTTON_RADIUS,
    paddingHorizontal: Spacing.L,
    ...Typography.BODY,
    color: theme.ink,
  },
  pickerRow: {
    paddingHorizontal: Spacing.L,
    paddingVertical: Spacing.L,
    borderBottomWidth: 1,
    borderBottomColor: theme.hairline,
  },
  pickerRowText: { ...Typography.BODY, color: theme.ink },
  pickerEmptyText: { ...Typography.CAPTION, color: theme.inkMuted, textAlign: 'center', marginTop: Spacing.XL },
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
  errorText: { ...Typography.ERROR, color: theme.down, marginTop: Spacing.S },
  hintText: { ...Typography.CAPTION, color: theme.inkMuted, marginTop: Spacing.M },
  notLiveBanner: {
    ...Typography.CAPTION,
    color: theme.brand,
    backgroundColor: theme.brandSoft,
    borderRadius: Spacing.CARD_RADIUS,
    padding: Spacing.M,
    marginBottom: Spacing.L,
  },

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

  qrCard: {
    alignSelf: 'center',
    backgroundColor: theme.ink,
    borderWidth: 1,
    borderColor: theme.hairline,
    borderRadius: 12,
    padding: Spacing.M,
    marginBottom: Spacing.M,
  },
  depositAddressText: { ...Typography.BODY, fontFamily: MONO, color: theme.ink, textAlign: 'center', marginBottom: Spacing.M },
  copyAddressButton: {
    height: Spacing.BUTTON_HEIGHT_PRIMARY,
    borderRadius: Spacing.BUTTON_RADIUS,
    borderWidth: 1,
    borderColor: theme.brand,
    justifyContent: 'center',
    alignItems: 'center',
  },
  copyAddressButtonText: { ...Typography.BUTTON_TEXT, color: theme.brand },

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

  destinationToggleRow: { flexDirection: 'row', alignItems: 'center', marginTop: Spacing.L },

  heroValue2: { fontFamily: MONO, fontSize: 26, fontWeight: '600', color: theme.ink, marginTop: Spacing.XS },
  tapToCopyHint: { ...Typography.CAPTION, color: theme.brand, marginBottom: Spacing.M },
  payDetailRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: Spacing.XS },
  payDetailLabel: { ...Typography.CAPTION, color: theme.inkFaint },
  payDetailValue: { ...Typography.BODY, color: theme.ink, fontWeight: '600' },
  payDetailAccount: { ...Typography.BODY, fontFamily: MONO, color: theme.brand, fontWeight: '700', letterSpacing: 1 },
  feeBreakdown: { marginTop: Spacing.M, paddingHorizontal: Spacing.XS },
  feeLabel: { ...Typography.CAPTION, fontFamily: MONO, color: theme.inkMuted },
  receiveRow: { marginTop: Spacing.S, paddingTop: Spacing.M, borderTopWidth: 1, borderTopColor: theme.hairline },
  receiveLabel: { ...Typography.BODY, fontWeight: '700', color: theme.ink },
  receiveValue: { ...Typography.BODY, fontFamily: MONO, fontWeight: '700', color: theme.brand },
  confirmWarningBox: {
    backgroundColor: theme.errorBg,
    borderRadius: Spacing.CARD_RADIUS,
    padding: Spacing.M,
    marginTop: Spacing.L,
  },
  doneButtonOutline: {
    height: Spacing.BUTTON_HEIGHT_PRIMARY,
    borderRadius: Spacing.BUTTON_RADIUS,
    borderWidth: 1,
    borderColor: theme.brand,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: Spacing.L,
    marginBottom: Spacing.XL,
  },

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
  });
}
