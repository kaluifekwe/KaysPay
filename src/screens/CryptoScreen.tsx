import React, { useState, useCallback, useEffect, useRef } from 'react';
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
  KeyboardAvoidingView,
  Keyboard,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { Typography } from '../constants/typography';
import { Spacing } from '../constants/spacing';
import { AppTheme } from '../constants/theme';
import { useTheme } from '../components/ThemeProvider';
import { formatNaira } from '../utils/formatCurrency';
import { storageHelpers, StorageKeys } from '../lib/mmkv';
import { analytics } from '../services/analytics.service';
import {
  cryptoService,
  isValidCryptoAddress,
  CRYPTO_NETWORKS,
  WITHDRAW_SINGLE_NETWORK_ASSETS,
  type CryptoAsset,
  type CryptoNetwork,
  type SavedCryptoAddress,
  type QuidaxWalletBalance,
  type CryptoBuyPayment,
  type BuyAsset,
  type MarketCoin,
  type CryptoSellQuote,
  type CryptoWithdrawQuote,
} from '../services/crypto.service';
import { kycService } from '../services/kyc.service';
import { useTransactionAuth } from '../components/TransactionAuthProvider';
import ProviderLogo from '../components/ProviderLogo';
import BankLogoIcon from '../components/BankLogoIcon';
import { CRYPTO_LOGOS } from '../utils/providerLogos';
import ResultStatusView, { type ResultStatus } from '../components/ResultStatusView';
import QrCodeView from '../components/QrCodeView';
import CryptoRefundBankModal from '../components/CryptoRefundBankModal';
import { supabase } from '../lib/supabase';

interface CryptoScreenProps {
  navigation: { goBack: () => void; navigate: (screen: string, params?: any) => void };
}

type Tab = 'deposit' | 'buy' | 'sell' | 'withdraw';

// Display-only snapshot for instant paint on open — see the mount effect
// and loadAll() below. Never consulted by any balance check that actually
// gates a Buy/Sell/Withdraw, which always re-fetch live.
interface CryptoScreenCache {
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

// How many decimals to show for a given coin. A stablecoin sits near 1
// naira-equivalent per unit, so 2dp is all that carries meaning — showing
// 15.24283 USDT reads as an unfinished number, not precision. Volatile
// coins are worth far more per unit, so they scale with size instead: a
// BTC amount is usually well under 0.01 and 2dp would round it to nothing.
function cryptoDecimals(n: number, code: string): number {
  if (code.toUpperCase() === 'USDT') return 2;
  const magnitude = Math.abs(n);
  if (magnitude >= 1) return 4;
  if (magnitude >= 0.01) return 6;
  return 8;
}

/**
 * Formats a crypto amount for display. Always rounds DOWN, never up —
 * this is a balance the customer may retype into Sell, and rounding 15.247
 * up to "15.25" would show more than they hold and fail on submit.
 */
function formatCrypto(n: number, code: string): string {
  const dp = cryptoDecimals(n, code);
  const factor = 10 ** dp;
  const floored = Math.floor((Number.isFinite(n) ? n : 0) * factor) / factor;
  return `${floored.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })} ${code}`;
}

function formatUsdt(n: number): string {
  return formatCrypto(n, 'USDT');
}

function formatCoin(n: number, code: string): string {
  return formatCrypto(n, code);
}

export default function CryptoScreen({ navigation }: CryptoScreenProps) {
  const { authorize } = useTransactionAuth();
  const { theme } = useTheme();
  const styles = createStyles(theme);
  const insets = useSafeAreaInsets();

  const [tab, setTab] = useState<Tab>('deposit');
  const scrollRef = useRef<ScrollView>(null);
  // The Buy/Sell amount fields sit well below the balance card, asset list,
  // and action row — not near the top of the screen the way they first
  // look within their own section. scrollToEnd() used to run here, but that
  // scrolls past the field to the true bottom of the form (Sell has Bank +
  // Account Number below it, Buy has a confirm box + button), which could
  // push the field itself off the TOP of the visible area instead of
  // showing it.
  //
  // A prior attempt measured the field itself via TextInput.measure() (the
  // legacy imperative UIManager callback), on the theory that its timing
  // just needed tuning against the keyboard's show animation. Neither a
  // short nor a long delay changed anything on a real device — the same
  // "no scroll happened at all" result both times, which pointed at the API
  // itself rather than its timing: measure()'s callback is known to be
  // unreliable (stale, zeroed, or simply never firing) under this app's New
  // Architecture / bridgeless renderer (RN 0.81, see AGENTS.md), not just a
  // one-off race.
  //
  // This avoids it entirely. Each step's own wrapping View reports its
  // position via onLayout — a plain layout event Fabric fully supports,
  // not an imperative measurement call — captured once when that step
  // renders. Scrolling on focus is then a fixed calculation, no runtime
  // measurement at all.
  const buySectionYRef = useRef(0);
  const sellSectionYRef = useRef(0);
  const scrollSectionIntoView = useCallback((sectionYRef: React.RefObject<number>) => {
    // A short delay only to let onLayout report back first on a section
    // that just became visible this same render (the autoFocus case below)
    // — the target position itself doesn't depend on keyboard timing at
    // all, unlike the old measure()-based approach, since onLayout's y is
    // fixed content-space position, not a live on-screen measurement.
    setTimeout(() => {
      const y = sectionYRef.current;
      if (y > 0) {
        scrollRef.current?.scrollTo({ y: Math.max(y - 20, 0), animated: true });
      }
    }, 50);
  }, []);
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

  // Buy is a 2-step flow: pick a coin from live prices, then set an amount
  // and (USDT only) choose where it's delivered together on one screen —
  // owner decision 2026-08-22, collapsing the previous separate destination
  // step since there was nothing left to review between the two.
  const [buyStep, setBuyStep] = useState<'pick' | 'amount'>('pick');
  // The amount field's onFocus alone isn't fully reliable here: it carries
  // autoFocus, so it fires the instant this step's View mounts, before
  // onLayout may have reported the section's position back yet. Triggering
  // the same scroll again off buyStep itself is a redundant, harmless
  // second attempt — scrollSectionIntoView already no-ops if the ref is
  // still unset.
  useEffect(() => {
    if (buyStep === 'amount') scrollSectionIntoView(buySectionYRef);
  }, [buyStep, scrollSectionIntoView]);
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
    expiresAt: number;
  } | null>(null);
  // Quidax's one-time bank account is only valid for 30 minutes (owner
  // confirmed 2026-08-22) — not something the API returns, so tracked
  // client-side from the moment the account is generated. Ticks once a
  // second only while this screen is actually showing.
  const [buyPaymentSecondsLeft, setBuyPaymentSecondsLeft] = useState(0);
  useEffect(() => {
    if (!pendingBuyPayment) return;
    const update = () => {
      setBuyPaymentSecondsLeft(Math.max(0, Math.round((pendingBuyPayment.expiresAt - Date.now()) / 1000)));
    };
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [pendingBuyPayment]);
  // Polling this order's status live after "Done — I'll transfer now", so the
  // purchase visibly lands instead of just going quiet until the screen is
  // manually reopened.
  const [buyPollTxId, setBuyPollTxId] = useState<string | null>(null);
  // Drives the 3-step progress checklist on the processing screen. Set once
  // Quidax confirms the deposit (mark_crypto_buy_fiat_received) — never
  // reset back to null mid-poll, so a slow/duplicate status read can't make
  // a step that already lit up flicker back off.
  const [buyFiatReceivedAt, setBuyFiatReceivedAt] = useState<string | null>(null);
  // Which coin this in-flight purchase is for. selectedBuyAsset is cleared
  // the moment the customer commits, so it's captured here to keep the
  // waiting/confirmation copy specific to what they actually bought.
  const [buyPollAsset, setBuyPollAsset] = useState<BuyAsset | null>(null);
  const [buyPollPendingSwap, setBuyPollPendingSwap] = useState(false);
  const [buyPollStartedAt, setBuyPollStartedAt] = useState<number | null>(null);
  const [buyElapsedSeconds, setBuyElapsedSeconds] = useState(0);
  useEffect(() => {
    if (!buyPollStartedAt) return;
    const update = () => setBuyElapsedSeconds(Math.max(0, Math.round((Date.now() - buyPollStartedAt) / 1000)));
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [buyPollStartedAt]);
  const [sellUsdt, setSellUsdt] = useState('');
  // Sell pays a bank account directly (off-ramp) — no separate verify step
  // for this first version; a name mismatch surfaces as an error after
  // tapping Sell, same as every other input on this screen already works.
  const [sellQuote, setSellQuote] = useState<CryptoSellQuote | null>(null);
  const [sellQuoteLoading, setSellQuoteLoading] = useState(false);
  const [sellQuoteError, setSellQuoteError] = useState<string | null>(null);

  const [wdAsset, setWdAsset] = useState<CryptoAsset>('USDT');
  const [wdNetwork, setWdNetwork] = useState<CryptoNetwork>('TRC20');
  const [wdAddress, setWdAddress] = useState('');
  const [wdAmount, setWdAmount] = useState('');
  const [wdVerified, setWdVerified] = useState(false);
  const [savedAddresses, setSavedAddresses] = useState<SavedCryptoAddress[]>([]);
  const [wdQuote, setWdQuote] = useState<CryptoWithdrawQuote | null>(null);
  const [wdQuoteLoading, setWdQuoteLoading] = useState(false);
  const [wdQuoteError, setWdQuoteError] = useState<string | null>(null);

  // A Buy Quidax auto-refunded (paying account name didn't match) and is
  // waiting on the customer's own bank details — see CryptoRefundBankModal.
  const [pendingRefund, setPendingRefund] = useState<{ transactionId: string; amountNgn: number } | null>(null);
  const [refundModalVisible, setRefundModalVisible] = useState(false);

  const loadAll = useCallback(async () => {
    const [usdt, liveRate, saved, quidaxAccount, refund] = await Promise.all([
      cryptoService.getBalance('USDT'),
      cryptoService.getQuoteRate(),
      cryptoService.listSavedAddresses('USDT'),
      cryptoService.getOrCreateAccount(),
      cryptoService.getPendingBuyRefund(),
    ]);
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

  // Refreshes balances every time this screen regains focus — needed now
  // that Sell's bank/confirm step lives on its own screen (CryptoSellBank):
  // returning here after a successful sale used to rely on that screen's
  // own loadAll() call, which no longer exists on this screen once the
  // action moved elsewhere.
  useFocusEffect(useCallback(() => { loadAll(); }, [loadAll]));

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
  // Withdraw's balance source generalizes to whichever asset is selected —
  // same live-from-Quidax rule as USDT, just keyed by wdAsset.
  const quidaxWdWallet = quidaxWallets.find((w) => w.currency === wdAsset);
  const wdBalance = wdAsset === 'USDT' ? quidaxUsdtBalance : (quidaxWdWallet ? Number(quidaxWdWallet.balance) : null);

  // Only actual crypto belongs in the crypto total and asset list. Quidax
  // also returns its fiat NGN wallet; mixing that into `heldWallets` made
  // the screen describe Naira as a crypto asset and obscured the fact that
  // an old conversion could still be awaiting settlement.
  const heldWallets = quidaxWallets.filter((w) => w.isCrypto && Number(w.balance) > 0);
  const quidaxNgnWallet = quidaxWallets.find((w) => w.currency === 'NGN');
  const quidaxNgnBalance = quidaxNgnWallet ? Number(quidaxNgnWallet.balance) : 0;
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
  }, [wdAddress, wdNetwork, wdAsset]);

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

  useEffect(() => {
    setBuyDestVerified(false);
  }, [buyDestAddress, buyDestNetwork]);

  const numericBuyNgn = parseFloat(buyNgn);
  const numericSellUsdt = parseFloat(sellUsdt);
  const numericWdAmount = parseFloat(wdAmount);

  useEffect(() => {
    setSellQuote(null);
    setSellQuoteError(null);
    if (!Number.isFinite(numericSellUsdt) || numericSellUsdt < 1 || numericSellUsdt > 2000) {
      setSellQuoteLoading(false);
      return;
    }
    let cancelled = false;
    const handle = setTimeout(async () => {
      setSellQuoteLoading(true);
      const result = await cryptoService.getSellQuote(numericSellUsdt);
      if (cancelled) return;
      setSellQuoteLoading(false);
      if (result.success && result.quote) setSellQuote(result.quote);
      else setSellQuoteError(result.error || 'Could not calculate the live network fee.');
    }, 400);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [numericSellUsdt]);

  // Same purpose as the sell-quote effect above: show the real network fee
  // before confirming, not after. Re-fetches on network/asset change too —
  // unlike Sell (one fixed network), Withdraw's fee depends entirely on
  // which network the customer picked (for USDT) or which asset (for a
  // single-network one), and TRC20/ERC20 differ from BEP20 by two orders of
  // magnitude for the identical send. No client-side amount floor/ceiling
  // here beyond "greater than zero" — the real min/max is asset-specific
  // (5 USDT means nothing for BTC) and comes back live in the quote itself.
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

  const wdAddressValid = wdAddress.trim().length > 0 && isValidCryptoAddress(wdAsset, wdAsset === 'USDT' ? wdNetwork : '', wdAddress);
  const wdAddressError = wdAddress.trim().length > 0 && !wdAddressValid
    ? `This doesn't look like a valid ${wdAsset === 'USDT' ? wdNetwork : wdAsset} address.`
    : null;

  const buyDestAddressValid = buyDestAddress.trim().length > 0 && isValidCryptoAddress('USDT', buyDestNetwork, buyDestAddress);
  const buyDestAddressError = buyDestAddress.trim().length > 0 && !buyDestAddressValid
    ? `This doesn't look like a valid ${buyDestNetwork} address.`
    : null;

  const buyBelowMin = buyLimits != null && numericBuyNgn > 0 && numericBuyNgn < buyLimits.minNgn;
  const buyAboveMax = buyLimits != null && numericBuyNgn > 0 && numericBuyNgn > buyLimits.maxNgn;
  const canBuy = !!selectedBuyAsset && Number.isFinite(numericBuyNgn) && numericBuyNgn > 0
    && !buyBelowMin && !buyAboveMax
    && (!buyToExternal || (buyDestAddressValid && buyDestVerified));
  // Bank/account details now live on CryptoSellBankScreen (step 2) — this
  // only gates whether the live quote is in a state worth proceeding from.
  const canProceedSell = Number.isFinite(numericSellUsdt) && numericSellUsdt >= 1 && numericSellUsdt <= 2000
    && sellQuote?.sufficient === true;

  const handleSellMax = useCallback(async () => {
    if (quidaxUsdtBalance == null || quidaxUsdtBalance < 1) return;
    setSellQuoteLoading(true);
    const result = await cryptoService.getSellQuote(Math.min(2000, quidaxUsdtBalance));
    setSellQuoteLoading(false);
    if (!result.success || !result.quote) {
      setSellQuoteError(result.error || 'Could not calculate the maximum sale amount.');
      return;
    }
    const maximum = Math.floor(result.quote.maxSell * 1_000_000) / 1_000_000;
    if (maximum < result.quote.minSell) {
      setSellQuote(result.quote);
      setSellQuoteError(`Your balance cannot cover the minimum ${formatUsdt(result.quote.minSell)} sale plus the ${formatUsdt(result.quote.networkFee)} network fee.`);
      return;
    }
    setSellUsdt(String(maximum));
  }, [quidaxUsdtBalance]);
  // Requires a live quote confirming both that the balance actually covers
  // amount + fee (not just amount — the same gap that let a full-balance
  // Sell pass locally and bounce at Quidax, fixed there first) and that the
  // amount clears this asset/network's real minimum and maximum — both
  // computed live per asset, never a flat USDT-shaped number (5 BTC would
  // be absurd, 2000 BTC more so).
  const canWithdraw = Number.isFinite(numericWdAmount) && numericWdAmount > 0
    && wdBalance != null && wdAddressValid && wdVerified
    && wdQuote?.sufficient === true && numericWdAmount >= wdQuote.minForNetwork
    && numericWdAmount <= wdQuote.maxLimit;

  const handleBuy = useCallback(async () => {
    if (!canBuy || !selectedBuyAsset || buyLoading) return;
    // Disabled BEFORE the PIN/biometric step, not after it. authorize()
    // awaits real user interaction, so leaving the button live until it
    // resolves let a second tap start an entirely separate purchase —
    // observed live as two orders 190ms apart, each with its own Quidax
    // bank account the customer could pay into. Same ordering the VTU
    // screens use.
    setBuyLoading(true);
    const subtitle = buyToExternal
      ? `To ${buyDestNetwork} wallet ${buyDestAddress.trim()}`
      : 'To your KaysPay Wallet';
    const authResult = await authorize({
      title: `Confirm ${selectedBuyAsset} Purchase`,
      amount: numericBuyNgn || undefined,
      subtitle,
      // Buy is paid by bank transfer straight to Quidax's one-time account
      // -- it never debits the KaysPay wallet (see crypto-buy/index.ts) --
      // so a wallet-balance check here is comparing against the wrong
      // number entirely and can wrongly block a purchase the user can
      // actually afford.
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
      setPendingBuyPayment({
        payment: result.payment,
        estimatedCrypto: result.estimatedCrypto ?? 0,
        destinationType: result.destinationType ?? 'kayspay_account',
        asset: result.asset ?? selectedBuyAsset,
        pendingSwap: !!result.pendingSwap,
        transactionId: result.transactionId ?? '',
        expiresAt: Date.now() + 30 * 60 * 1000,
      });
      // Deliberately NOT resetting buyStep/selectedBuyAsset/buyNgn here —
      // cancelling out of the bank-details screen needs to land back on
      // the amount screen with the coin and amount still filled in, not on
      // a blank coin picker. These only clear once the user actually
      // commits via "Done — I'll transfer now" below.
      loadAll();
    } else {
      void analytics.track('crypto_buy_failed', { outcome: 'failed', failureCode: 'purchase_rejected' });
      setActionError(result.error || 'Purchase failed. Please try again.');
      setActionState('failed');
    }
  }, [canBuy, selectedBuyAsset, buyLoading, numericBuyNgn, buyToExternal, buyDestNetwork, buyDestAddress, authorize, loadAll]);

  const handleProceedToSell = useCallback(() => {
    if (!canProceedSell || !sellQuote) return;
    navigation.navigate('CryptoSellBank', { sellUsdt: numericSellUsdt, sellQuote });
  }, [canProceedSell, sellQuote, numericSellUsdt, navigation]);

  const submitWithdraw = useCallback(async () => {
    const wdNetworkForRequest = wdAsset === 'USDT' ? wdNetwork : '';
    const authResult = await authorize({
      title: 'Confirm Crypto Withdrawal',
      subtitle: `${numericWdAmount} ${wdAsset} · ${wdAsset === 'USDT' ? wdNetwork : wdAsset} · ${wdAddress.trim()}`,
    });
    if (!authResult) return;
    setActionAmountNgn(null);
    setActionState('processing');
    const result = await cryptoService.withdraw(wdAsset, wdNetworkForRequest, wdAddress, numericWdAmount, authResult.token);
    if (result.success) {
      setActionMessage(result.message ?? null);
      setActionState('success');
      await cryptoService.saveAddress(wdAsset, wdNetworkForRequest, wdAddress, '');
      setWdAddress('');
      setWdAmount('');
      setWdVerified(false);
      loadAll();
    } else {
      setActionError(result.error || 'Withdrawal failed. Please try again.');
      setActionState('failed');
    }
  }, [numericWdAmount, wdAsset, wdNetwork, wdAddress, authorize, loadAll]);

  const handleWithdraw = useCallback(() => {
    if (!canWithdraw) return;
    submitWithdraw();
  }, [canWithdraw, submitWithdraw]);

  // Explicit reset on an actual asset-picker tap only — NOT a useEffect
  // keyed on wdAsset, which would also fire (and wipe the address right
  // back out) when handlePickSaved below sets both asset and address
  // together for a saved BTC/USDT address.
  const handlePickWdAsset = useCallback((next: CryptoAsset) => {
    setWdAsset(next);
    setWdAddress('');
    setWdAmount('');
    setWdVerified(false);
  }, []);

  const handlePickSaved = useCallback((addr: SavedCryptoAddress) => {
    setWdAsset(addr.asset);
    if (addr.asset === 'USDT' && addr.network) setWdNetwork(addr.network as CryptoNetwork);
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

    const applyStatus = (result: Awaited<ReturnType<typeof cryptoService.getBuyOrderStatus>>) => {
      if (!result || cancelled) return false;
      if (result.fiatReceivedAt) setBuyFiatReceivedAt(result.fiatReceivedAt);
      if (result.status === 'completed') {
        const coin = buyPollAsset ?? 'crypto';
        setActionMessage(`Your ${coin} has landed — it's in your crypto wallet now.`);
        setActionState('success');
        setBuyPollTxId(null);
        loadAll();
        return true;
      }
      // Payment confirmed by the provider, delivery still running. This is a
      // real milestone worth closing the loop on: the customer's money is
      // accounted for, so they shouldn't be held on a spinner for the
      // remaining couple of minutes. Deliberately says "Payment confirmed"
      // rather than a bare "Successful" — the coin genuinely hasn't arrived
      // yet and the delivery leg can still fail, so claiming outright
      // success here would be telling them something untrue about their
      // money. Polling continues underneath, so if it does land while
      // they're still watching, the message above replaces this one.
      if (result.fiatReceivedAt) {
        const coin = buyPollAsset ?? 'crypto';
        setActionMessage(
          buyPollPendingSwap
            ? `Your ${coin} is on the way. It arrives as USDT first, then converts to ${coin} — usually within a few minutes. You can close this screen.`
            : `Your ${coin} is on the way. It usually lands in your crypto wallet within 2–3 minutes. You can close this screen.`,
        );
        setActionState('success');
        return false; // keep polling so a real completion still updates this
      }
      if (result.needsRefundBankDetails) {
        setActionState('idle');
        setBuyPollTxId(null);
        loadAll();
        return true;
      }
      if (result.status === 'failed') {
        setActionError(result.failureReason || 'This purchase could not be completed.');
        setActionState('failed');
        setBuyPollTxId(null);
        return true;
      }
      return false;
    };

    // Realtime removes the normal 0–4 second polling delay once the signed
    // webhook updates this exact row. RLS still limits the caller to their
    // own transaction; the primary-key filter avoids unrelated traffic.
    const channel = supabase
      .channel(`crypto-buy-${buyPollTxId}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'transactions', filter: `id=eq.${buyPollTxId}` },
        (payload) => {
          const row = payload.new as { status?: string; metadata?: Record<string, unknown> };
          applyStatus({
            status: String(row.status || 'pending'),
            failureReason: typeof row.metadata?.failure_reason === 'string' ? row.metadata.failure_reason : undefined,
            needsRefundBankDetails: row.metadata?.needs_refund_bank_details === true,
            fiatReceivedAt: typeof row.metadata?.fiat_received_at === 'string' ? row.metadata.fiat_received_at : undefined,
          });
        },
      )
      .subscribe();

    const poll = async () => {
      if (cancelled) return;
      attempts++;
      // Every third pass (~12s), ask the backend to query Quidax directly.
      // Other passes are cheap database reads. This closes a delayed-webhook
      // gap without allowing the client to settle money or hammer Quidax.
      const refreshed = attempts % 3 === 0
        ? await cryptoService.refreshBuyOrderStatus(buyPollTxId)
        : null;
      const result = refreshed ?? await cryptoService.getBuyOrderStatus(buyPollTxId);
      if (cancelled) return;
      if (applyStatus(result)) return;
      if (attempts >= MAX_ATTEMPTS) {
        // Still pending after a generous wait — stop polling rather than
        // spin forever. Nothing is lost: the reconcile sweep and the push
        // notification trigger both still settle this independently.
        setActionMessage("This is taking longer than usual. It's still being worked on — check Transaction History for the result, no need to wait here.");
        setActionState('success');
        setBuyPollTxId(null);
        return;
      }
      setTimeout(poll, 4000);
    };
    poll();

    return () => {
      cancelled = true;
      void supabase.removeChannel(channel);
    };
  }, [buyPollTxId, buyPollAsset, buyPollPendingSwap, loadAll]);

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
    const buyPaymentExpired = buyPaymentSecondsLeft <= 0;
    const countdownMinutes = Math.floor(buyPaymentSecondsLeft / 60);
    const countdownSeconds = buyPaymentSecondsLeft % 60;
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
          {buyPaymentExpired ? (
            <View style={styles.expiredBox}>
              <Ionicons name="time-outline" size={28} color={theme.down} />
              <Text style={styles.expiredTitle}>This bank account has expired</Text>
              <Text style={styles.expiredText}>
                This one-time account is only valid for 30 minutes. Start a new purchase to get a fresh one.
              </Text>
              <TouchableOpacity
                style={styles.copyAddressButton}
                onPress={() => setPendingBuyPayment(null)}
              >
                <Text style={styles.copyAddressButtonText}>Start over</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View style={styles.expiryBanner}>
              <Ionicons name="time-outline" size={16} color={theme.gold} />
              <Text style={styles.expiryBannerText}>
                Expires in {countdownMinutes}:{countdownSeconds.toString().padStart(2, '0')}
              </Text>
            </View>
          )}
          {!buyPaymentExpired && (
          <>
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
              ? `Into your KaysPay Wallet — first as USDT once the transfer clears, then automatically converted to ${asset}.`
              : `Into ${destinationType === 'external_wallet' ? 'your external wallet' : 'your KaysPay Wallet'} once the transfer clears.`}
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
              // Only clear the coin/amount now that the user has committed
              // to actually making the transfer — cancelling instead (below)
              // deliberately leaves these alone.
              setBuyStep('pick');
              setSelectedBuyAsset(null);
              setBuyNgn('');
              setBuyDestAddress('');
              setBuyDestVerified(false);
              if (txId) {
                setActionAmountNgn(payment.amount);
                setActionMessage("We're watching for your transfer — this updates automatically.");
                setActionState('processing');
                setBuyFiatReceivedAt(null);
                setBuyPollAsset(asset);
                setBuyPollPendingSwap(pendingSwap);
                setBuyPollStartedAt(Date.now());
                setBuyPollTxId(txId);
              }
            }}
          >
            <Text style={styles.copyAddressButtonText}>Done — I'll transfer now</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.cancelPurchaseButton}
            onPress={() => setPendingBuyPayment(null)}
          >
            <Text style={styles.cancelPurchaseButtonText}>Cancel this purchase</Text>
          </TouchableOpacity>
          </>
          )}
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
        // While delivery is still running the money is confirmed but the coin
        // hasn't arrived, so this must not read as a plain "Successful".
        successLabel={buyPollTxId && buyFiatReceivedAt ? 'Payment confirmed' : undefined}
        processingHint={buyPollTxId ? 'Checking for your transfer…' : undefined}
        onDone={() => {
          setActionMessage(null);
          setActionState('idle');
          setBuyPollTxId(null);
          setBuyFiatReceivedAt(null);
          setBuyPollStartedAt(null);
          setBuyPollAsset(null);
          setBuyPollPendingSwap(false);
        }}
      >
        {actionState === 'processing' && buyPollTxId ? (
          <View style={{ width: '100%' }}>
            <Text style={styles.buyProgressHint}>
              Usually a few minutes · {Math.floor(buyElapsedSeconds / 60)}:{(buyElapsedSeconds % 60).toString().padStart(2, '0')} elapsed
            </Text>
            <View style={styles.buyProgressList}>
              <View style={styles.buyProgressRow}>
                <View style={[styles.buyProgressDot, styles.buyProgressDotDone]}>
                  <Ionicons name="checkmark" size={13} color="#FFFFFF" />
                </View>
                <Text style={styles.buyProgressLabel}>Payment sent</Text>
              </View>
              <View style={[styles.buyProgressLine, buyFiatReceivedAt ? styles.buyProgressLineDone : null]} />
              <View style={styles.buyProgressRow}>
                <View style={[styles.buyProgressDot, buyFiatReceivedAt ? styles.buyProgressDotDone : styles.buyProgressDotPending]}>
                  {buyFiatReceivedAt && <Ionicons name="checkmark" size={13} color="#FFFFFF" />}
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.buyProgressLabel}>Payment received</Text>
                  {!buyFiatReceivedAt && <Text style={styles.buyProgressSubLabel}>Waiting to confirm your transfer</Text>}
                </View>
              </View>
              <View style={styles.buyProgressLine} />
              <View style={styles.buyProgressRow}>
                <View style={styles.buyProgressDotPending} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.buyProgressLabel}>Converting and delivering</Text>
                  <Text style={styles.buyProgressSubLabel}>This screen updates on its own</Text>
                </View>
              </View>
            </View>
            <TouchableOpacity
              onPress={() => {
                setActionMessage("You can check back anytime — it'll show as completed here once it's done.");
                setActionState('success');
                setBuyPollTxId(null);
              }}
              style={{ marginTop: Spacing.L, alignSelf: 'center' }}
            >
              <Text style={{ color: theme.brand, fontWeight: '600' }}>Leave this screen</Text>
            </TouchableOpacity>
          </View>
        ) : null}
      </ResultStatusView>
    );
  }

  if (!serviceEnabled) {
    return (
      <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
        <StatusBar barStyle={theme.mode === 'dark' ? 'light-content' : 'dark-content'} backgroundColor={theme.background} />
        <View style={styles.topBar}>
          <TouchableOpacity style={styles.backButton} activeOpacity={0.6} onPress={() => { Keyboard.dismiss(); navigation.goBack(); }}>
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
        <TouchableOpacity style={styles.backButton} activeOpacity={0.6} onPress={() => { Keyboard.dismiss(); navigation.goBack(); }}>
          <Ionicons name="chevron-back" size={26} color={theme.ink} />
        </TouchableOpacity>
        <Text style={styles.topTitle}>Crypto</Text>
      </View>

      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          ref={scrollRef}
          style={styles.flex}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          showsVerticalScrollIndicator={false}
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

          {/* Hidden while actively entering an amount (Buy's combined amount
              screen, or Sell) — this balance card, asset list, and action
              row push the amount field far enough down the page that the
              keyboard covers it, even after it's brought into view, since
              there's nowhere higher left to scroll to. Removing them here
              is a structural fix rather than another scroll calculation:
              with nothing above it, the field sits at the top on its own. */}
          {!((tab === 'buy' && buyStep === 'amount') || tab === 'sell') && (
          <>
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

          {quidaxNgnBalance > 0 && (
            <View style={styles.nairaCard}>
              <View style={styles.nairaLeft}>
                <View style={styles.nairaIcon}>
                  <Text style={styles.nairaIconText}>₦</Text>
                </View>
                <View style={styles.nairaCopy}>
                  <Text style={styles.nairaName}>Naira settlement balance</Text>
                  <Text style={styles.nairaHint}>From a crypto conversion · separate from your KaysPay wallet</Text>
                </View>
              </View>
              <Text style={styles.nairaValue}>
                {balanceVisible ? formatNaira(quidaxNgnBalance) : '₦ ••••••'}
              </Text>
            </View>
          )}

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
            {/* Withdraw (crypto -> external wallet) was parked 2026-08-20
                (migration 141) as a narrower, lower-priority feature behind
                the 'crypto_withdraw' kill switch. Re-added to the tab list
                2026-09-02 now that it's been extended past USDT-only (BTC,
                see crypto-withdraw-assets.ts) and is an active feature
                again — the kill switch itself was already left enabled. */}
            {(['deposit', 'buy', 'sell', 'withdraw'] as Tab[]).map((t) => (
              <TouchableOpacity key={t} style={styles.actionItem} onPress={() => handleSelectTab(t)} activeOpacity={0.75}>
                <View style={[styles.actionIcon, tab === t && styles.actionIconActive]}>
                  <Ionicons name={TAB_ICONS[t]} size={20} color={theme.brand} />
                </View>
                <Text style={[styles.actionLabel, tab === t && styles.actionLabelActive]}>{TAB_LABELS[t]}</Text>
              </TouchableOpacity>
            ))}
          </View>
          </>
          )}

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
              <View onLayout={(e) => { buySectionYRef.current = e.nativeEvent.layout.y; }}>
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
                  autoFocus
                  onFocus={() => scrollSectionIntoView(buySectionYRef)}
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

            {tab === 'sell' && kycVerified !== false && (
              <View onLayout={(e) => { sellSectionYRef.current = e.nativeEvent.layout.y; }}>
                <Text style={styles.label}>Amount (USDT)</Text>
                <TextInput
                  style={styles.input}
                  value={sellUsdt}
                  onChangeText={(t) => setSellUsdt(t.replace(/[^0-9.]/g, ''))}
                  placeholder="e.g. 10"
                  placeholderTextColor={theme.inkFaint}
                  keyboardType="decimal-pad"
                  onFocus={() => scrollSectionIntoView(sellSectionYRef)}
                />
                <View style={styles.sellBalanceRow}>
                  <Text style={styles.hintText}>
                    Available: {quidaxUsdtBalance != null ? formatUsdt(quidaxUsdtBalance) : '—'}
                  </Text>
                  <TouchableOpacity onPress={handleSellMax} disabled={sellQuoteLoading || quidaxUsdtBalance == null}>
                    <Text style={styles.sellMaxText}>Sell Max</Text>
                  </TouchableOpacity>
                </View>
                {sellNgnEstimate != null && (
                  <Text style={styles.estimateText}>≈ {formatNaira(sellNgnEstimate)}</Text>
                )}
                {sellQuoteLoading && (
                  <View style={styles.checkingRow}>
                    <ActivityIndicator size="small" color={theme.gold} />
                    <Text style={styles.checkingText}>Checking live rate…</Text>
                  </View>
                )}
                {sellQuote && (
                  <View style={styles.sellQuoteCard}>
                    <Text style={styles.sellQuoteText}>Amount to sell: {formatUsdt(sellQuote.amount)}</Text>
                    {/* The network name comes from the quote rather than being
                        hardcoded: it read "TRC20" even after selling moved to
                        BEP20, so the customer was shown the wrong chain next to
                        a real fee. */}
                    <Text style={styles.sellQuoteText}>
                      {sellQuote.network.toUpperCase()} network fee: {formatUsdt(sellQuote.networkFee)}
                    </Text>
                    <Text style={styles.sellQuoteTotal}>Total required: {formatUsdt(sellQuote.totalRequired)}</Text>
                    {/* Quidax's own figure for what lands in the bank. The
                        estimate above it is a market rate times the amount, so
                        it cannot know about their processor fee and always
                        reads high — a real 2 USDT sale showed ≈₦2,756 and paid
                        ₦2,668. Shown only when their quote answered. */}
                    {sellQuote.expectedNgn != null && (
                      <Text style={styles.sellQuoteReceive}>
                        You receive: {formatNaira(sellQuote.expectedNgn)}
                      </Text>
                    )}
                  </View>
                )}
                {sellQuote && !sellQuote.sufficient && (
                  <Text style={styles.errorText}>
                    You need {formatUsdt(sellQuote.totalRequired)}, but only {formatUsdt(sellQuote.available)} is available.
                  </Text>
                )}
                {sellQuoteError && <Text style={styles.errorText}>{sellQuoteError}</Text>}

                <TouchableOpacity
                  style={[styles.primaryButton, !canProceedSell && styles.primaryButtonDisabled]}
                  onPress={handleProceedToSell}
                  disabled={!canProceedSell}
                >
                  <Text style={styles.primaryButtonText}>Proceed to Sell</Text>
                </TouchableOpacity>
                <Text style={styles.hintText}>
                  {sellQuoteLoading ? 'Waiting for the live rate…' : 'Bank details are on the next screen.'}
                </Text>
              </View>
            )}

            {tab === 'withdraw' && (
              <View>
                <Text style={styles.notLiveBanner}>
                  Sends crypto held in your KaysPay Wallet to any external wallet. Network fees are deducted by the
                  network itself.
                </Text>

                <Text style={styles.label}>Asset</Text>
                <View style={styles.networkRow}>
                  {(['USDT', ...WITHDRAW_SINGLE_NETWORK_ASSETS] as CryptoAsset[]).map((a) => (
                    <TouchableOpacity
                      key={a}
                      style={[styles.networkChip, wdAsset === a && styles.networkChipSelected]}
                      onPress={() => handlePickWdAsset(a)}
                    >
                      <Text style={[styles.networkChipText, wdAsset === a && styles.networkChipTextSelected]}>
                        {a}
                      </Text>
                    </TouchableOpacity>
                  ))}
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
                {wdAddressError && <Text style={styles.errorText}>{wdAddressError}</Text>}

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
                  <View style={styles.sellQuoteCard}>
                    <Text style={styles.sellQuoteText}>Amount to withdraw: {formatCoin(wdQuote.amount, wdAsset)}</Text>
                    <Text style={styles.sellQuoteText}>
                      {wdQuote.network} network fee: {formatCoin(wdQuote.networkFee, wdAsset)}
                      {wdQuote.feeSharePercent != null ? ` (${wdQuote.feeSharePercent}%)` : ''}
                    </Text>
                    <Text style={styles.sellQuoteTotal}>Total required: {formatCoin(wdQuote.totalRequired, wdAsset)}</Text>
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
                  style={[styles.primaryButton, !canWithdraw && styles.primaryButtonDisabled]}
                  onPress={handleWithdraw}
                  disabled={!canWithdraw}
                >
                  <Text style={styles.primaryButtonText}>Withdraw {wdAsset}</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>

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

  expiryBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.S,
    backgroundColor: theme.goldSoft,
    borderRadius: Spacing.CARD_RADIUS,
    padding: Spacing.M,
    marginBottom: Spacing.M,
  },
  expiryBannerText: { ...Typography.BODY, fontWeight: '700', color: theme.gold },
  expiredBox: {
    alignItems: 'center',
    backgroundColor: theme.surfaceRaised,
    borderRadius: Spacing.CARD_RADIUS,
    padding: Spacing.L,
    gap: Spacing.S,
  },
  expiredTitle: { ...Typography.SECTION_HEADING, color: theme.ink, textAlign: 'center' },
  expiredText: { ...Typography.BODY, color: theme.inkMuted, textAlign: 'center', marginBottom: Spacing.S },

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
  nairaLeft: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: Spacing.M },
  nairaCopy: { flex: 1 },
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
  buyProgressHint: { ...Typography.CAPTION, color: theme.inkMuted, textAlign: 'center', marginBottom: Spacing.M },
  buyProgressList: { alignSelf: 'stretch' },
  buyProgressRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.S },
  buyProgressDot: {
    width: 22,
    height: 22,
    borderRadius: 11,
    justifyContent: 'center',
    alignItems: 'center',
  },
  buyProgressDotDone: { backgroundColor: theme.brand },
  buyProgressDotPending: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: theme.brand,
  },
  buyProgressLine: { width: 2, height: 14, backgroundColor: theme.hairline, marginLeft: 10 },
  buyProgressLineDone: { backgroundColor: theme.brand },
  buyProgressLabel: { ...Typography.BODY_SMALL, fontWeight: '700', color: theme.ink },
  buyProgressSubLabel: { ...Typography.CAPTION, color: theme.inkFaint },
  sellBalanceRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  sellMaxText: { ...Typography.BODY_SMALL, color: theme.brand, fontWeight: '700' },
  // Deliberately visible rather than just a caption swap — the live fee
  // lookup used to update the numbers silently, which read as broken/laggy
  // rather than as something actually happening.
  checkingRow: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.S, marginTop: Spacing.S,
    backgroundColor: theme.goldSoft, borderRadius: 10, paddingVertical: Spacing.S, paddingHorizontal: Spacing.M,
  },
  checkingText: { ...Typography.BODY_SMALL, color: theme.gold, fontWeight: '600' },
  sellQuoteCard: { marginTop: Spacing.S, padding: Spacing.M, borderRadius: 12, backgroundColor: theme.surfaceRaised },
  sellQuoteText: { ...Typography.BODY_SMALL, color: theme.inkMuted, marginBottom: 4 },
  sellQuoteTotal: { ...Typography.BODY, color: theme.ink, fontWeight: '700' },
  sellQuoteReceive: { ...Typography.BODY, color: theme.brand, fontWeight: '700', marginTop: 6 },
  receiveRow: { marginTop: Spacing.S, paddingTop: Spacing.M, borderTopWidth: 1, borderTopColor: theme.hairline },
  receiveLabel: { ...Typography.BODY, fontWeight: '700', color: theme.ink },
  receiveValue: { ...Typography.BODY, fontFamily: MONO, fontWeight: '700', color: theme.brand },
  confirmWarningBox: {
    backgroundColor: theme.errorBg,
    borderRadius: Spacing.CARD_RADIUS,
    padding: Spacing.M,
    marginTop: Spacing.L,
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
  cancelPurchaseButton: {
    height: Spacing.BUTTON_HEIGHT_PRIMARY,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: -Spacing.M,
    marginBottom: Spacing.XL,
  },
  cancelPurchaseButtonText: { ...Typography.BUTTON_TEXT, color: theme.inkMuted },

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
