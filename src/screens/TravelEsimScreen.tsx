import React, { useState, useCallback, useMemo, useEffect } from 'react';
import {
  View,
  StyleSheet,
  Text,
  Image,
  ScrollView,
  FlatList,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  Modal,
  Linking,
  Platform,
  BackHandler,
  KeyboardAvoidingView,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppTheme } from '../constants/theme';
import { useTheme } from '../components/ThemeProvider';
import { Typography } from '../constants/typography';
import { Spacing } from '../constants/spacing';
import { useSensitiveScreenProtection } from '../hooks/useSensitiveScreenProtection';
import { formatNaira } from '../utils/formatCurrency';
import {
  esimService,
  flagFromCode,
  type EsimCountry,
  type EsimPlan,
  type MyEsim,
} from '../services/esim.service';
import { walletService } from '../services/wallet.service';
import { useCachedData } from '../hooks/useCachedData';
import { useTransactionAuth } from '../components/TransactionAuthProvider';
import ResultStatusView from '../components/ResultStatusView';

interface TravelEsimScreenProps {
  navigation: {
    goBack: () => void;
    navigate: (screen: string) => void;
  };
}

type BuyState = 'idle' | 'processing' | 'success' | 'error';
type Tab = 'browse' | 'my';
type Sort = 'featured' | 'cheapest' | 'az';

// Curated popular destinations for Nigerian travellers — pinned at the top of
// the "Featured" sort with a badge. Pure merchandising; not tied to the live
// catalog (any code not currently offered just doesn't appear).
const FEATURED_CODES = ['GB', 'US', 'AE', 'CA', 'SA', 'CN', 'ZA', 'GH'];
const FEATURED_SET = new Set(FEATURED_CODES);

type BrowseRow = { type: 'header'; label: string } | { type: 'country'; country: EsimCountry };

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch {
    return '';
  }
}

export default function TravelEsimScreen({ navigation }: TravelEsimScreenProps) {
  useSensitiveScreenProtection();
  const { authorize } = useTransactionAuth();
  const { theme } = useTheme();
  const styles = createStyles(theme);
  const insets = useSafeAreaInsets();

  const {
    data: countries,
    loading: countriesLoading,
    error: countriesError,
    refresh: refreshCountries,
  } = useCachedData<EsimCountry[]>(
    'esim_countries',
    () => esimService.loadCountries(),
    { scope: 'global' },
  );

  const { data: myEsims, refresh: refreshMyEsims } = useCachedData<MyEsim[]>(
    'esim_my_esims',
    () => esimService.getMyEsims(),
  );

  const { data: balance } = useCachedData<number>('esim_wallet_balance', async () => {
    const r = await walletService.getWallet();
    if (!r.success || !r.wallet) throw new Error('balance');
    return r.wallet.available_balance;
  });

  const [tab, setTab] = useState<Tab>('browse');
  const [sort, setSort] = useState<Sort>('featured');
  const [countrySearch, setCountrySearch] = useState('');

  const countryName = useCallback(
    (code: string) => (countries || []).find((c) => c.code === code)?.name || code,
    [countries],
  );

  const browseData = useMemo<BrowseRow[]>(() => {
    const list = countries || [];
    const q = countrySearch.trim().toLowerCase();
    const filtered = q ? list.filter((c) => c.name.toLowerCase().includes(q)) : list;

    if (sort === 'featured' && !q) {
      const featured = FEATURED_CODES.map((code) => list.find((c) => c.code === code)).filter(
        Boolean,
      ) as EsimCountry[];
      const others = filtered
        .filter((c) => !FEATURED_SET.has(c.code))
        .sort((a, b) => a.name.localeCompare(b.name));
      const rows: BrowseRow[] = [];
      if (featured.length) {
        rows.push({ type: 'header', label: 'Featured' });
        featured.forEach((c) => rows.push({ type: 'country', country: c }));
      }
      rows.push({ type: 'header', label: 'All countries' });
      others.forEach((c) => rows.push({ type: 'country', country: c }));
      return rows;
    }

    const sorted =
      sort === 'cheapest'
        ? [...filtered].sort((a, b) => (a.fromKobo ?? Infinity) - (b.fromKobo ?? Infinity))
        : [...filtered].sort((a, b) => a.name.localeCompare(b.name));
    return sorted.map((c) => ({ type: 'country', country: c }));
  }, [countries, countrySearch, sort]);

  const [selectedCountry, setSelectedCountry] = useState<EsimCountry | null>(null);
  const [plans, setPlans] = useState<EsimPlan[]>([]);
  const [loadingPlans, setLoadingPlans] = useState(false);
  const [plansError, setPlansError] = useState('');
  const [selectedPlan, setSelectedPlan] = useState<EsimPlan | null>(null);

  const [buyState, setBuyState] = useState<BuyState>('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const [resultPending, setResultPending] = useState(false);
  const [resultMessage, setResultMessage] = useState('');
  const [resultQrUrl, setResultQrUrl] = useState<string | null>(null);
  const [resultAppleInstallUrl, setResultAppleInstallUrl] = useState<string | null>(null);

  const [viewingEsim, setViewingEsim] = useState<MyEsim | null>(null);

  const handleCountrySelect = useCallback(async (country: EsimCountry) => {
    setSelectedCountry(country);
    setSelectedPlan(null);
    setPlans([]);
    setPlansError('');
    setLoadingPlans(true);

    const result = await esimService.browsePlans({ country: country.code });

    setLoadingPlans(false);
    if (!result.success) {
      setPlansError(result.error || 'Could not load plans for this destination');
      return;
    }
    setPlans(result.plans);
    if (result.plans.length === 0) {
      setPlansError('No plans available for this destination right now.');
    }
  }, []);

  const handleBackToBrowse = useCallback(() => {
    setSelectedCountry(null);
    setSelectedPlan(null);
    setPlans([]);
    setPlansError('');
  }, []);

  // Phone/gesture back on the plan sub-screen returns to the country list
  // (like the on-screen "<") instead of popping the whole screen to Home.
  useEffect(() => {
    const onHardwareBack = () => {
      if (selectedCountry) { handleBackToBrowse(); return true; }
      return false;
    };
    const sub = BackHandler.addEventListener('hardwareBackPress', onHardwareBack);
    return () => sub.remove();
  }, [selectedCountry, handleBackToBrowse]);

  const handlePay = useCallback(async () => {
    if (!selectedPlan || !selectedCountry || buyState === 'processing') return;

    const authResult = await authorize({
      title: 'Confirm eSIM Purchase',
      amount: selectedPlan.priceKobo / 100,
    });
    if (!authResult) return;

    setErrorMessage('');
    setBuyState('processing');

    try {
      const result = await esimService.buyPlan(
        selectedPlan.id,
        { country: selectedCountry.code },
        authResult.token,
      );

      if (result.success) {
        setResultPending(!!result.pending);
        setResultMessage(result.message || '');
        setResultQrUrl(result.qrcode_url || null);
        setResultAppleInstallUrl(result.direct_apple_installation_url || null);
        setBuyState('success');
        refreshMyEsims();
      } else {
        setErrorMessage(result.error || 'eSIM purchase failed. Please try again.');
        setBuyState('error');
      }
    } catch {
      setErrorMessage('An unexpected error occurred. Please check your connection and try again.');
      setBuyState('error');
    }
  }, [selectedPlan, selectedCountry, buyState, authorize, refreshMyEsims]);

  const handleDismissResult = useCallback(() => {
    setBuyState('idle');
    setErrorMessage('');
    setSelectedCountry(null);
    setSelectedPlan(null);
    setPlans([]);
    setCountrySearch('');
    setResultPending(false);
    setResultQrUrl(null);
    setResultAppleInstallUrl(null);
    setTab('my');
  }, []);

  const esimLabel = (e: MyEsim): string =>
    e.planName ||
    `${esimService.formatDataAmount(e.dataMB)}${e.days ? ` · ${e.days} days` : ''}`;

  // ---- Success screen ----
  const buyAmount = selectedPlan ? selectedPlan.priceKobo / 100 : undefined;

  // Tap Buy -> straight to Processing (set before the async call) -> Ready/Failed.
  if (buyState === 'processing') {
    return (
      <ResultStatusView
        status="processing"
        headerTitle="eSIM"
        amount={buyAmount}
        processingHint="Setting up your eSIM…"
      />
    );
  }

  if (buyState === 'error') {
    return (
      <ResultStatusView
        status="failed"
        headerTitle="eSIM"
        amount={buyAmount}
        message={errorMessage || 'eSIM purchase failed. Please try again.'}
        onDone={() => setBuyState('idle')}
        doneLabel="Try Again"
      />
    );
  }

  if (buyState === 'success') {
    return (
      <ResultStatusView
        status="success"
        headerTitle="eSIM"
        amount={resultPending ? undefined : buyAmount}
        successLabel={resultPending ? 'eSIM Processing' : 'eSIM Ready'}
        message={resultPending ? (resultMessage || "You'll be notified once it's ready. Check My eSIMs for updates.") : undefined}
        onDone={handleDismissResult}
      >
        {!resultPending && (
          <View style={{ alignItems: 'center', width: '100%' }}>
            <Text style={styles.resultDetail}>{selectedCountry?.name}</Text>
            <Text style={styles.resultDetail}>{selectedPlan?.name}</Text>
            {resultQrUrl && (
              <View style={styles.qrContainer}>
                <Image source={{ uri: resultQrUrl }} style={styles.qrImage} resizeMode="contain" />
                {Platform.OS === 'ios' && resultAppleInstallUrl ? (
                  <TouchableOpacity
                    style={[styles.primaryButton, styles.installButton]}
                    onPress={() => Linking.openURL(resultAppleInstallUrl)}
                  >
                    <Text style={styles.primaryButtonText}>Install on this iPhone</Text>
                  </TouchableOpacity>
                ) : (
                  <Text style={styles.qrHint}>
                    Scan this QR in your phone's eSIM settings (Settings → Cellular/Mobile → Add eSIM). If it's the
                    same phone you're viewing this on, view the QR on another device first — a phone can't scan its
                    own screen.
                  </Text>
                )}
                <Text style={[styles.qrHint, { marginTop: Spacing.M }]}>
                  Install it now while you have Wi-Fi — switch it on only once you land. Most plans start counting
                  days from first connection abroad, not from purchase.
                </Text>
              </View>
            )}
          </View>
        )}
      </ResultStatusView>
    );
  }

  // The branches above narrow this render to idle. Keep an explicit runtime
  // guard as defense-in-depth against rapid repeat taps during state changes.
  const isPurchaseProcessing = (buyState as BuyState) === 'processing';

  // ---- Shared header (hero + tabs) ----
  const heroAndTabs = (
    <View>
      <View style={styles.hero}>
        <Text style={styles.heroTitle}>eSIM Store</Text>
        <Text style={styles.heroTagline}>Data eSIMs for travel & connectivity worldwide.</Text>
        <View style={styles.heroRow}>
          <View style={styles.balancePill}>
            <Text style={styles.balanceText}>
              Balance: {balance != null ? formatNaira(balance) : '—'}
            </Text>
          </View>
          <View style={styles.heroActions}>
            <TouchableOpacity onPress={() => navigation.navigate('WalletFunding')}>
              <Text style={styles.heroLink}>Fund</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => navigation.navigate('TransactionHistory')}>
              <Text style={styles.heroLink}>History</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>

      <View style={styles.tabs}>
        <TouchableOpacity
          style={[styles.tab, tab === 'browse' && styles.tabActive]}
          onPress={() => setTab('browse')}
        >
          <Text style={[styles.tabText, tab === 'browse' && styles.tabTextActive]}>Browse Plans</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tab, tab === 'my' && styles.tabActive]}
          onPress={() => setTab('my')}
        >
          <Text style={[styles.tabText, tab === 'my' && styles.tabTextActive]}>My eSIMs</Text>
        </TouchableOpacity>
      </View>
    </View>
  );

  const browseHeader = (
    <View>
      {heroAndTabs}
      <TextInput
        style={styles.searchInput}
        value={countrySearch}
        onChangeText={setCountrySearch}
        placeholder="Search country..."
        placeholderTextColor={theme.inkMuted}
      />
      <View style={styles.sortRow}>
        {([
          ['featured', 'Featured'],
          ['cheapest', 'Cheapest'],
          ['az', 'A–Z'],
        ] as [Sort, string][]).map(([key, lbl]) => (
          <TouchableOpacity
            key={key}
            style={[styles.sortChip, sort === key && styles.sortChipActive]}
            onPress={() => setSort(key)}
          >
            <Text style={[styles.sortChipText, sort === key && styles.sortChipTextActive]}>{lbl}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );

  const renderCountryRow = (country: EsimCountry) => (
    <TouchableOpacity style={styles.row} activeOpacity={0.7} onPress={() => handleCountrySelect(country)}>
      <View style={styles.rowLeft}>
        <Text style={styles.rowCode}>{country.flag} {country.code}</Text>
        <Text style={styles.rowName}>{country.name}</Text>
        {country.fromKobo != null && (
          <Text style={styles.rowFrom}>From {formatNaira(country.fromKobo / 100)}</Text>
        )}
        <Text style={styles.rowTap}>Tap to view all plans</Text>
        {FEATURED_SET.has(country.code) && (
          <View style={styles.featuredBadge}>
            <Text style={styles.featuredBadgeText}>Featured</Text>
          </View>
        )}
      </View>
      <View style={styles.proceedBtn}>
        <Text style={styles.proceedText}>Proceed</Text>
      </View>
    </TouchableOpacity>
  );

  // ---- Plan selection sub-screen ----
  if (selectedCountry) {
    return (
      <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
        <View style={styles.topBar}>
          <TouchableOpacity style={styles.backButton} activeOpacity={0.6} onPress={handleBackToBrowse}>
            <Text style={styles.backText}>{'<'}</Text>
          </TouchableOpacity>
          <Text style={styles.topTitle}>eSIM Store</Text>
        </View>

        <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
          <View style={styles.selectedCountryChip}>
            <Text style={styles.countryFlag}>{selectedCountry.flag}</Text>
            <Text style={styles.selectedCountryName}>{selectedCountry.name}</Text>
          </View>
          <Text style={styles.label}>Select a plan</Text>
          <Text style={styles.compatNote}>
            Requires a carrier-unlocked, eSIM-compatible phone. Not sure? Check Settings on your phone before buying.
          </Text>

          {loadingPlans ? (
            <View style={styles.loadingContainer}>
              <ActivityIndicator color={theme.brand} />
              <Text style={styles.loadingText}>Finding the best plans...</Text>
            </View>
          ) : plansError ? (
            <Text style={styles.amountError}>{plansError}</Text>
          ) : (
            <View style={styles.plansContainer}>
              {plans.map((plan) => {
                const isSelected = selectedPlan?.id === plan.id;
                return (
                  <TouchableOpacity
                    key={plan.id}
                    style={[styles.planCard, isSelected && styles.planCardSelected]}
                    onPress={() => setSelectedPlan(plan)}
                    activeOpacity={0.7}
                  >
                    <View style={styles.planInfo}>
                      <Text style={[styles.planData, isSelected && styles.planDataSelected]}>
                        {esimService.formatDataAmount(plan.dataMB)}
                      </Text>
                      <Text style={styles.planDays}>{plan.days} days</Text>
                    </View>
                    <Text style={[styles.planPrice, isSelected && styles.planPriceSelected]}>
                      {formatNaira(plan.priceKobo / 100)}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          )}

          {errorMessage ? (
            <View style={styles.errorContainer}>
              <Text style={styles.errorText}>{errorMessage}</Text>
            </View>
          ) : null}
        </ScrollView>

        {selectedPlan && (
          <View style={[styles.bottomBar, { paddingBottom: insets.bottom + Spacing.L }]}>
            <View style={styles.summary}>
              <Text style={styles.summaryText} numberOfLines={1}>
                {selectedCountry.name} · {esimService.formatDataAmount(selectedPlan.dataMB)} / {selectedPlan.days}d
              </Text>
              <Text style={styles.summaryAmount}>{formatNaira(selectedPlan.priceKobo / 100)}</Text>
            </View>
            <TouchableOpacity
              style={[styles.primaryButton, isPurchaseProcessing && styles.primaryButtonDisabled]}
              onPress={handlePay}
              disabled={isPurchaseProcessing}
            >
              {isPurchaseProcessing ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <Text style={styles.primaryButtonText}>Buy {formatNaira(selectedPlan.priceKobo / 100)}</Text>
              )}
            </TouchableOpacity>
          </View>
        )}
      </SafeAreaView>
    );
  }

  // ---- Store home (Browse / My eSIMs) ----
  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      <View style={styles.topBar}>
        <TouchableOpacity style={styles.backButton} activeOpacity={0.6} onPress={() => navigation.goBack()}>
          <Text style={styles.backText}>{'<'}</Text>
        </TouchableOpacity>
        <Text style={styles.topTitle}>eSIM Store</Text>
      </View>

      <KeyboardAvoidingView style={styles.keyboardView} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      {tab === 'browse' ? (
        <FlatList
          data={browseData}
          keyExtractor={(item, i) => (item.type === 'country' ? item.country.code : `h-${item.label}-${i}`)}
          renderItem={({ item }) =>
            item.type === 'header' ? (
              <Text style={styles.sectionHeader}>{item.label}</Text>
            ) : (
              renderCountryRow(item.country)
            )
          }
          ListHeaderComponent={browseHeader}
          ListEmptyComponent={
            !countries && countriesLoading ? (
              <View style={styles.loadingContainer}>
                <ActivityIndicator color={theme.brand} />
                <Text style={styles.loadingText}>Loading destinations...</Text>
              </View>
            ) : !countries && countriesError ? (
              <View style={styles.loadingContainer}>
                <Text style={styles.amountError}>Could not load destinations.</Text>
                <TouchableOpacity style={styles.retryButton} onPress={refreshCountries}>
                  <Text style={styles.retryButtonText}>Retry</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <Text style={styles.amountError}>No countries match "{countrySearch}"</Text>
            )
          }
          contentContainerStyle={styles.listContent}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'}
          showsVerticalScrollIndicator={false}
        />
      ) : (
        <FlatList
          data={myEsims || []}
          keyExtractor={(e) => e.id}
          renderItem={({ item: e }) => (
            <TouchableOpacity style={styles.myRow} activeOpacity={0.7} onPress={() => setViewingEsim(e)}>
              <Text style={styles.myFlag}>{flagFromCode(e.countryCode)}</Text>
              <View style={styles.rowLeft}>
                <Text style={styles.rowName}>{countryName(e.countryCode)}</Text>
                <Text style={styles.mySub}>{esimLabel(e)}</Text>
                <Text style={styles.myDate}>{formatDate(e.purchasedAt)}</Text>
              </View>
              <Text style={styles.myView}>View QR</Text>
            </TouchableOpacity>
          )}
          ListHeaderComponent={heroAndTabs}
          ListEmptyComponent={
            <Text style={styles.emptyText}>You haven't bought any eSIMs yet. Browse plans to get started.</Text>
          }
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
        />
      )}
      </KeyboardAvoidingView>

      <Modal visible={!!viewingEsim} transparent animationType="slide" onRequestClose={() => setViewingEsim(null)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalSheet}>
            <View style={styles.modalHandle} />
            <Text style={styles.resultTitle}>{viewingEsim ? countryName(viewingEsim.countryCode) : ''} eSIM</Text>
            {viewingEsim ? <Text style={styles.resultDetail}>{esimLabel(viewingEsim)}</Text> : null}
            {viewingEsim?.qrcodeUrl && (
              <View style={styles.qrContainer}>
                <Image source={{ uri: viewingEsim.qrcodeUrl }} style={styles.qrImage} resizeMode="contain" />
              </View>
            )}
            <Text style={styles.qrHint}>
              Scan this QR on the phone you want the eSIM on: Settings → Cellular / Mobile → Add eSIM. If it's the
              same phone, view the QR on another device first — a phone can't scan its own screen.
            </Text>
            {viewingEsim?.iccid ? <Text style={styles.iccidText}>ICCID: {viewingEsim.iccid}</Text> : null}
            {Platform.OS === 'ios' && !!viewingEsim?.appleInstallUrl && (
              <TouchableOpacity
                style={styles.primaryButton}
                onPress={() => Linking.openURL(String(viewingEsim.appleInstallUrl))}
              >
                <Text style={styles.primaryButtonText}>Install on this iPhone</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity style={styles.modalClose} onPress={() => setViewingEsim(null)}>
              <Text style={styles.modalCloseText}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
  keyboardView: { flex: 1 },
  container: { flex: 1, backgroundColor: theme.background },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.SCREEN_PADDING,
    paddingTop: Spacing.S,
    paddingBottom: Spacing.S,
  },
  backButton: { width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
  backText: { fontSize: 26, fontWeight: '600', color: theme.ink },
  topTitle: { ...Typography.SECTION_HEADING, color: theme.ink, marginLeft: Spacing.S },
  listContent: { paddingHorizontal: Spacing.SCREEN_PADDING, paddingBottom: 140 },

  hero: {
    backgroundColor: theme.brand,
    borderRadius: Spacing.CARD_RADIUS,
    padding: Spacing.L,
    marginTop: Spacing.S,
    marginBottom: Spacing.L,
  },
  heroTitle: { ...Typography.SCREEN_TITLE, color: '#FFFFFF' },
  heroTagline: { ...Typography.CAPTION, color: '#FFFFFF', opacity: 0.9, marginTop: 4 },
  heroRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: Spacing.M,
  },
  balancePill: {
    backgroundColor: 'rgba(255,255,255,0.2)',
    borderRadius: 20,
    paddingHorizontal: Spacing.M,
    paddingVertical: 6,
  },
  balanceText: { ...Typography.BODY, color: '#FFFFFF', fontWeight: '700' },
  heroActions: { flexDirection: 'row', gap: Spacing.L },
  heroLink: { ...Typography.BODY, color: '#FFFFFF', fontWeight: '700' },

  tabs: {
    flexDirection: 'row',
    backgroundColor: theme.surfaceRaised,
    borderRadius: Spacing.BUTTON_RADIUS,
    padding: 4,
    marginBottom: Spacing.L,
  },
  tab: { flex: 1, paddingVertical: Spacing.S, borderRadius: Spacing.BUTTON_RADIUS - 2, alignItems: 'center' },
  tabActive: { backgroundColor: theme.surface },
  tabText: { ...Typography.BODY, color: theme.inkMuted, fontWeight: '600' },
  tabTextActive: { color: theme.brand },

  searchInput: {
    height: Spacing.INPUT_HEIGHT,
    borderWidth: Spacing.INPUT_BORDER_WIDTH,
    borderColor: theme.border,
    borderRadius: Spacing.BUTTON_RADIUS,
    paddingHorizontal: Spacing.L,
    ...Typography.BODY,
    color: theme.ink,
    marginBottom: Spacing.M,
  },
  sortRow: { flexDirection: 'row', gap: Spacing.S, marginBottom: Spacing.M },
  sortChip: {
    paddingHorizontal: Spacing.M,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: theme.border,
  },
  sortChipActive: { backgroundColor: theme.brandSoft, borderColor: theme.brand },
  sortChipText: { ...Typography.CAPTION, color: theme.inkMuted, fontWeight: '600' },
  sortChipTextActive: { color: theme.brand },

  sectionHeader: { ...Typography.SECTION_HEADING, color: theme.ink, marginTop: Spacing.M, marginBottom: Spacing.S },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: Spacing.CARD_RADIUS,
    padding: Spacing.CARD_PADDING,
    marginBottom: Spacing.M,
  },
  rowLeft: { flex: 1 },
  rowCode: { ...Typography.CAPTION, color: theme.inkMuted },
  rowName: { ...Typography.CARD_TITLE, color: theme.ink, marginTop: 2 },
  rowFrom: { ...Typography.BODY, color: theme.brand, fontWeight: '700', marginTop: 2 },
  rowTap: { ...Typography.CAPTION, color: theme.inkMuted, marginTop: 2 },
  featuredBadge: {
    alignSelf: 'flex-start',
    backgroundColor: theme.brandSoft,
    borderRadius: 10,
    paddingHorizontal: Spacing.S,
    paddingVertical: 2,
    marginTop: Spacing.S,
  },
  featuredBadgeText: { ...Typography.CAPTION, color: theme.brand, fontWeight: '700' },
  proceedBtn: {
    backgroundColor: theme.brand,
    borderRadius: Spacing.BUTTON_RADIUS,
    paddingHorizontal: Spacing.L,
    paddingVertical: Spacing.S,
    marginLeft: Spacing.M,
  },
  proceedText: { ...Typography.BODY, color: '#FFFFFF', fontWeight: '700' },

  myRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: Spacing.CARD_RADIUS,
    padding: Spacing.CARD_PADDING,
    marginBottom: Spacing.M,
  },
  myFlag: { fontSize: 28, marginRight: Spacing.M },
  mySub: { ...Typography.BODY, color: theme.ink, marginTop: 2 },
  myDate: { ...Typography.CAPTION, color: theme.inkMuted, marginTop: 2 },
  myView: { ...Typography.CAPTION, color: theme.brand, fontWeight: '700', marginLeft: Spacing.M },
  emptyText: { ...Typography.BODY, color: theme.inkMuted, textAlign: 'center', paddingVertical: Spacing.XL },

  compatNote: { ...Typography.CAPTION, color: theme.inkMuted, marginBottom: Spacing.M },
  installButton: { marginTop: Spacing.M, alignSelf: 'stretch' },
  selectedCountryChip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.brandSoft,
    borderRadius: Spacing.BUTTON_RADIUS,
    paddingVertical: Spacing.S,
    paddingHorizontal: Spacing.M,
    marginBottom: Spacing.L,
    alignSelf: 'flex-start',
  },
  countryFlag: { fontSize: 24 },
  selectedCountryName: { ...Typography.BODY, color: theme.brand, fontWeight: '600', marginLeft: Spacing.S },
  label: { ...Typography.SECTION_HEADING, color: theme.ink, marginBottom: Spacing.M },
  scrollContent: { paddingHorizontal: Spacing.SCREEN_PADDING, paddingTop: Spacing.M, paddingBottom: 140 },

  loadingContainer: { alignItems: 'center', paddingVertical: Spacing.XL },
  loadingText: { ...Typography.CAPTION, color: theme.inkMuted, marginTop: Spacing.M },
  retryButton: {
    marginTop: Spacing.M,
    paddingVertical: Spacing.S,
    paddingHorizontal: Spacing.L,
    borderRadius: Spacing.BUTTON_RADIUS,
    borderWidth: 1,
    borderColor: theme.brand,
  },
  retryButtonText: { ...Typography.BODY, color: theme.brand, fontWeight: '600' },

  plansContainer: { gap: Spacing.M },
  planCard: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: Spacing.CARD_RADIUS,
    padding: Spacing.CARD_PADDING,
  },
  planCardSelected: { borderColor: theme.brand, borderWidth: 2, backgroundColor: theme.brandSoft },
  planInfo: { flex: 1 },
  planData: { ...Typography.CARD_TITLE, color: theme.ink },
  planDataSelected: { color: theme.brand },
  planDays: { ...Typography.CAPTION, color: theme.inkMuted, marginTop: 2 },
  planPrice: { ...Typography.AMOUNT_SMALL, color: theme.ink },
  planPriceSelected: { color: theme.brand },
  amountError: { ...Typography.ERROR, textAlign: 'center' },
  errorContainer: { marginTop: Spacing.M },
  errorText: { ...Typography.ERROR },

  bottomBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: theme.surface,
    borderTopWidth: 1,
    borderTopColor: theme.border,
    paddingHorizontal: Spacing.SCREEN_PADDING,
    paddingTop: Spacing.L,
  },
  summary: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: Spacing.L },
  summaryText: { ...Typography.BODY, color: theme.ink, flex: 1 },
  summaryAmount: { ...Typography.AMOUNT_SMALL, color: theme.ink },
  primaryButton: {
    height: Spacing.BUTTON_HEIGHT_PRIMARY,
    backgroundColor: theme.brand,
    borderRadius: Spacing.BUTTON_RADIUS,
    justifyContent: 'center',
    alignItems: 'center',
    alignSelf: 'stretch',
  },
  primaryButtonDisabled: { opacity: 0.5 },
  primaryButtonText: { ...Typography.BUTTON_TEXT },

  resultContainer: { flexGrow: 1, justifyContent: 'center', alignItems: 'center', padding: Spacing.SCREEN_PADDING },
  successIcon: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: theme.brand,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: Spacing.XL,
  },
  successIconText: { fontSize: 36, color: '#FFFFFF' },
  resultTitle: { ...Typography.SCREEN_TITLE, color: theme.ink, marginBottom: Spacing.M, textAlign: 'center' },
  resultDetail: { ...Typography.BODY, color: theme.inkMuted, marginBottom: Spacing.S, textAlign: 'center' },
  qrContainer: { alignItems: 'center', marginTop: Spacing.L, marginBottom: Spacing.L },
  qrImage: { width: 220, height: 220, marginBottom: Spacing.M },
  qrHint: { ...Typography.CAPTION, color: theme.inkMuted, textAlign: 'center', paddingHorizontal: Spacing.L },
  iccidText: { ...Typography.CAPTION, color: theme.ink, textAlign: 'center', marginTop: Spacing.S },

  modalOverlay: { flex: 1, backgroundColor: 'rgba(0, 0, 0, 0.5)', justifyContent: 'flex-end' },
  modalSheet: {
    backgroundColor: theme.surface,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: Spacing.L,
    paddingTop: Spacing.S,
    paddingBottom: Spacing.XL,
    alignItems: 'center',
  },
  modalHandle: { width: 40, height: 4, borderRadius: 2, backgroundColor: theme.border, alignSelf: 'center', marginBottom: Spacing.M },
  modalClose: {
    height: Spacing.BUTTON_HEIGHT_PRIMARY,
    borderRadius: Spacing.BUTTON_RADIUS,
    borderWidth: 1,
    borderColor: theme.border,
    justifyContent: 'center',
    alignItems: 'center',
    alignSelf: 'stretch',
    marginTop: Spacing.M,
  },
  modalCloseText: { ...Typography.BUTTON_TEXT, color: theme.ink },
  });
}
