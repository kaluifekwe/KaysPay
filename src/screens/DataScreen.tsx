import React, { useState, useCallback, useMemo, useRef } from 'react';
import {
  View,
  StyleSheet,
  Text,
  KeyboardAvoidingView,
  Platform,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  Switch,
  ScrollView,
  Keyboard,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { Colors } from '../constants/colors';
import { AppTheme } from '../constants/theme';
import { useTheme } from '../components/ThemeProvider';
import { Typography } from '../constants/typography';
import { Spacing } from '../constants/spacing';
import { Strings } from '../constants/strings';
import {
  detectNetwork,
  isValidPhoneFormat,
  formatNigerianPhone,
} from '../utils/detectNetwork';
import { formatNaira } from '../utils/formatCurrency';
import {
  vtuService,
  type DataBundle,
  type NetworkProvider,
} from '../services/vtu.service';
import { walletService } from '../services/wallet.service';
import { useTransactionAuth } from '../components/TransactionAuthProvider';
import ContactPickerModal from '../components/ContactPickerModal';
import ProviderLogo from '../components/ProviderLogo';
import { PickedContact } from '../services/contacts.service';
import { NETWORK_LOGOS } from '../utils/providerLogos';
import { isRestrictedPlanName } from '../utils/planWarnings';
import { kycService } from '../services/kyc.service';

interface DataScreenProps {
  navigation: any;
}

type BuyState = 'idle' | 'processing' | 'success' | 'error';
type BundleFilter = 'all' | 'daily' | 'weekly' | 'monthly';

const BUNDLE_FILTERS: { key: BundleFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'daily', label: 'Daily' },
  { key: 'weekly', label: 'Weekly' },
  { key: 'monthly', label: 'Monthly' },
];

function validityDays(validity: string): number | null {
  const match = validity.toLowerCase().match(/(\d+(?:\.\d+)?)\s*(day|week|month)/);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  if (match[2] === 'week') return value * 7;
  if (match[2] === 'month') return value * 30;
  return value;
}

function matchesBundleFilter(bundle: DataBundle, filter: BundleFilter): boolean {
  if (filter === 'all') return true;
  const days = validityDays(bundle.validity);
  if (days === null) return false;
  if (filter === 'daily') return days <= 1;
  if (filter === 'weekly') return days > 1 && days <= 7;
  return days > 7;
}

function bundlePresentation(bundle: DataBundle): {
  title: string;
  category: string | null;
  warning: string | null;
} {
  const categoryMatches = [...bundle.name.matchAll(/\(([^)]+)\)/g)];
  const category = categoryMatches.at(-1)?.[1]?.replace(/([a-z])([A-Z])/g, '$1 $2').trim() ?? null;
  const restricted = isRestrictedPlanName(bundle.name);
  let title = bundle.name
    .replace(/\s*\([^)]+\)\s*/g, ' ')
    .replace(/^do not buy\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (restricted) {
    title = title.split(/\s+if\s+you\s+are\s+owing/i)[0]?.trim() || title;
  }

  return {
    title,
    category,
    warning: restricted ? `Unavailable if owing ${networkLabel(bundle.network)} airtime` : null,
  };
}

const NETWORKS: { key: NetworkProvider; label: string }[] = [
  { key: 'mtn', label: 'MTN' },
  { key: 'airtel', label: 'Airtel' },
  { key: 'glo', label: 'Glo' },
];

const NETWORK_COLORS: Record<NetworkProvider, string> = {
  mtn: Colors.MTN,
  airtel: Colors.AIRTEL,
  glo: Colors.GLO,
  '9mobile': Colors.MOBILE,
};

const DATA_MIN = 100;
const DATA_MAX = 50000;

function networkLabel(network: NetworkProvider): string {
  return NETWORKS.find((n) => n.key === network)?.label ?? network;
}

export default function DataScreen({ navigation }: DataScreenProps) {
  const { authorize } = useTransactionAuth();
  const { theme } = useTheme();
  const styles = createStyles(theme);
  const insets = useSafeAreaInsets();
  const [phoneNumber, setPhoneNumber] = useState('');
  const scrollRef = useRef<ScrollView>(null);
  const [selectedNetwork, setSelectedNetwork] = useState<NetworkProvider | null>(null);
  const [selectedBundle, setSelectedBundle] = useState<DataBundle | null>(null);
  const [buyState, setBuyState] = useState<BuyState>('idle');
  const [resultPending, setResultPending] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [pickerMode, setPickerMode] = useState<'closed' | 'single' | 'multi'>('closed');
  const [bundles, setBundles] = useState<DataBundle[]>([]);
  const [bundlesNetwork, setBundlesNetwork] = useState<NetworkProvider | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [cashbackBalance, setCashbackBalance] = useState(0);
  const [bundleFilter, setBundleFilter] = useState<BundleFilter>('all');
  // Defaults off (owner-approved, 2026-08-16): auto-applying let cashback
  // earn on one purchase and get silently spent on the very next one before
  // it ever felt like it accumulated. Now it only spends when the user
  // explicitly opts in on this screen.
  const [useCashback, setUseCashback] = useState(false);

  // The server (debit_for_service, migration 222) is the real gate and blocks
  // this regardless of what the client shows — this is purely so an
  // unverified user lands on a clear next step instead of a purchase that
  // silently fails at the last second. Same defense-in-depth reasoning
  // CryptoBuyScreen documents for its own KYC check.
  const [kycVerified, setKycVerified] = useState<boolean | null>(null);
  useFocusEffect(
    useCallback(() => {
      kycService.getStatus().then((s) => {
        setKycVerified((prev) => (s.checkFailed && prev === true ? true : s.verified));
      });
    }, []),
  );

  useFocusEffect(useCallback(() => {
    let cancelled = false;
    walletService.getWallet().then((result) => {
      if (!cancelled && result.success && result.wallet) {
        setCashbackBalance(result.wallet.cashback_balance);
      }
    });
    return () => { cancelled = true; };
  }, []));

  // Preview only — the server always computes the real split from the
  // actual stored balance (never trusts this), same discipline as every
  // other amount shown before payment in this app.
  const cashbackApplied = useCashback && selectedBundle
    ? Math.min(cashbackBalance, selectedBundle.amount)
    : 0;
  const walletAmount = selectedBundle ? selectedBundle.amount - cashbackApplied : 0;

  const detectedNetwork = useMemo(() => {
    const digits = phoneNumber.replace(/\D/g, '');
    if (digits.length >= 4) {
      return detectNetwork(digits);
    }
    return null;
  }, [phoneNumber]);

  const autoDetectedNetwork = useMemo(() => {
    if (!detectedNetwork || detectedNetwork.network === 'Unknown') return null;
    const lower = detectedNetwork.network.toLowerCase();
    if (lower === 'mtn' || lower === 'airtel' || lower === 'glo') {
      return lower as NetworkProvider;
    }
    return null;
  }, [detectedNetwork]);

  const effectiveNetwork = selectedNetwork || autoDetectedNetwork;
  const displayedBundles = bundlesNetwork === effectiveNetwork ? bundles : [];
  const filteredBundles = useMemo(
    () => displayedBundles.filter((bundle) => matchesBundleFilter(bundle, bundleFilter)),
    [displayedBundles, bundleFilter],
  );
  const catalogTransitioning = effectiveNetwork !== null && bundlesNetwork !== effectiveNetwork;
  const catalogBusy = catalogLoading || catalogTransitioning;

  useFocusEffect(useCallback(() => {
    let cancelled = false;
    if (!effectiveNetwork) {
      setBundles([]);
      setBundlesNetwork(null);
      setCatalogLoading(false);
      return () => { cancelled = true; };
    }

    const cached = vtuService.getDataBundles(effectiveNetwork);
    setBundles(cached);
    setBundlesNetwork(effectiveNetwork);
    // Only show the loading row on a true first-load (no cached bundles at
    // all) — the refresh below still runs silently in the background every
    // time so prices stay current, but the user doesn't need to see it.
    // NOTE: `cached` is never truly empty — getDataBundles() falls back to a
    // small hardcoded sample list when there's no real synced catalog yet —
    // so checking cached.length here would never detect a genuine first
    // load. hasCachedDataBundles() checks for REAL cached data specifically.
    setCatalogLoading(!vtuService.hasCachedDataBundles(effectiveNetwork));
    const applyFreshCatalog = (fresh: DataBundle[]) => {
      if (cancelled) return;
      setBundles(fresh);
      setBundlesNetwork(effectiveNetwork);
      setSelectedBundle((selected) => {
        if (!selected) return null;
        return fresh.find((bundle) => bundle.id === selected.id) ?? null;
      });
    };
    const refresh = () => vtuService.refreshDataBundles(effectiveNetwork, true).then(applyFreshCatalog).finally(() => {
      if (!cancelled) setCatalogLoading(false);
    });
    void refresh();
    const availability = vtuService.subscribeToDataAvailability(effectiveNetwork, () => { void refresh(); });
    return () => {
      cancelled = true;
      availability.unsubscribe();
    };
  }, [effectiveNetwork]));

  const handlePhoneChange = useCallback((text: string) => {
    let digits = text.replace(/\D/g, '');
    // A pasted international format (+234 803… or 234 803…) normalizes to the
    // local 0-prefixed form, so copy-pasting a full number keeps all 11 digits
    // instead of losing the country code (or being cut mid-number).
    if (digits.startsWith('234')) digits = '0' + digits.slice(3);
    setPhoneNumber(formatNigerianPhone(digits.slice(0, 11)));
    setSelectedBundle(null);
  }, []);

  const handleNetworkSelect = useCallback((network: NetworkProvider) => {
    setSelectedNetwork((prev) => (prev === network ? null : network));
    setSelectedBundle(null);
    setBundleFilter('all');
  }, []);

  const handleBundleSelect = useCallback((bundle: DataBundle) => {
    setSelectedBundle((prev) => {
      if (prev?.id === bundle.id) return null; // deselecting — no warning needed
      if (isRestrictedPlanName(bundle.name)) {
        Alert.alert(
          'Restricted plan',
          `This plan can fail if you owe airtime on ${networkLabel(effectiveNetwork ?? bundle.network)}. Only continue if you have no outstanding airtime balance.`,
          [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Continue', onPress: () => setSelectedBundle(bundle) },
          ],
        );
        return prev; // don't select yet — wait for confirmation
      }
      return bundle;
    });
  }, [effectiveNetwork]);

  const handleContactSelect = useCallback((c: PickedContact) => {
    if (c.network === '9mobile') {
      Alert.alert('Network unavailable', '9mobile purchases are currently unavailable.');
      return;
    }
    setPhoneNumber(formatNigerianPhone(c.phone));
    setSelectedNetwork(c.network);
    setSelectedBundle(null);
    setPickerMode('closed');
  }, []);

  const handleBulkContactsSelected = useCallback(
    (contacts: PickedContact[]) => {
      setPickerMode('closed');
      const supported = contacts.filter((contact) => contact.network !== '9mobile');
      if (supported.length === 0) {
        // Every picked contact was 9mobile — don't just close the picker on
        // a dead end; let the user try a different selection right away.
        Alert.alert(
          '9mobile unavailable',
          'All the contacts you picked are on 9mobile, which is currently unsupported. Choose different contacts to continue.',
          [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Choose Again', onPress: () => setPickerMode('multi') },
          ],
        );
        return;
      }
      if (supported.length !== contacts.length) {
        Alert.alert('9mobile removed', '9mobile contacts were excluded from this purchase.');
      }
      if (supported.length === 1) {
        handleContactSelect(supported[0]);
        return;
      }
      navigation.navigate('BulkSendReview', { type: 'data', recipients: supported });
    },
    [navigation, handleContactSelect],
  );

  const handleBuy = useCallback(async () => {
    const digits = phoneNumber.replace(/\D/g, '');

    if (!isValidPhoneFormat(digits)) {
      setErrorMessage(Strings.ERROR_INVALID_PHONE);
      return;
    }

    if (!effectiveNetwork) {
      setErrorMessage('Please select a network');
      return;
    }

    if (!selectedBundle) {
      setErrorMessage('Please select a data bundle');
      return;
    }

    const bundleAmount = selectedBundle.amount;
    if (bundleAmount < DATA_MIN || bundleAmount > DATA_MAX) {
      setErrorMessage(`Data bundle amount must be between ${formatNaira(DATA_MIN)} and ${formatNaira(DATA_MAX)}`);
      return;
    }

    setBuyState('processing');
    const authResult = await authorize({ title: 'Confirm Data Purchase', amount: walletAmount });
    if (!authResult) {
      setBuyState('idle');
      return;
    }

    setErrorMessage('');
    // Go STRAIGHT to the result screen — it runs the purchase itself and shows
    // Processing -> Successful. No spinner on the Buy button first.
    navigation.navigate('TransactionStatus', {
      title: 'Data',
      amount: selectedBundle.amount,
      recipient: phoneNumber,
      paymentMethod: 'Balance',
      request: {
        kind: 'data',
        phone: digits,
        network: effectiveNetwork,
        bundle: selectedBundle,
        authToken: authResult.token,
        useCashback: cashbackApplied > 0,
      },
    });
  }, [phoneNumber, effectiveNetwork, selectedBundle, authorize, navigation, cashbackApplied]);

  const handleDismissResult = useCallback(() => {
    setBuyState('idle');
    setResultPending(false);
    setErrorMessage('');
    setPhoneNumber('');
    setSelectedNetwork(null);
    setSelectedBundle(null);
  }, []);

  // The single next thing the user must do before Pay can proceed — so the
  // greyed button is never a silent dead end. null once everything's ready.
  const payHint = useMemo(() => {
    if (buyState === 'processing') return null;
    if (!isValidPhoneFormat(phoneNumber.replace(/\D/g, ''))) return "Enter the recipient's phone number";
    if (!effectiveNetwork) return 'Select a network to continue';
    if (!selectedBundle) return 'Choose a data bundle to continue';
    return null;
  }, [buyState, phoneNumber, effectiveNetwork, selectedBundle]);

  if (kycVerified === false) {
    return (
      <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
        <View style={styles.scrollContent}>
          <TouchableOpacity
            style={styles.backButton}
            activeOpacity={0.6}
            onPress={() => navigation.goBack()}
          >
            <Text style={styles.backText}>{'<'}</Text>
          </TouchableOpacity>
          <Text style={styles.title}>Buy Data</Text>
          <View style={styles.kycGate}>
            <View style={styles.kycGateIconWrap}>
              <Ionicons name="shield-checkmark-outline" size={28} color={theme.brand} />
            </View>
            <Text style={styles.kycGateTitle}>Verify Your Identity</Text>
            <Text style={styles.kycGateSubtitle}>
              Buying data requires identity verification. Verify your NIN or BVN to continue — it only takes a minute.
            </Text>
            <TouchableOpacity
              style={[styles.primaryButton, styles.kycGateButton]}
              onPress={() => navigation.navigate('Kyc', { requiredFor: 'buy data' })}
              activeOpacity={0.85}
            >
              <Text style={styles.primaryButtonText}>Verify Now</Text>
            </TouchableOpacity>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  if (buyState === 'success') {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.resultContainer}>
          <View style={styles.successIcon}>
            <Text style={styles.successIconText}>{'✓'}</Text>
          </View>
          <Text style={styles.resultTitle}>
            {resultPending ? 'Order Processing' : Strings.SUCCESS_TRANSACTION}
          </Text>
          {resultPending && (
            <Text style={styles.resultDetail}>You'll be notified once it completes.</Text>
          )}
          <Text style={styles.resultDetail}>
            {selectedBundle?.name} data bundle on {effectiveNetwork ? networkLabel(effectiveNetwork) : ''}
          </Text>
          <Text style={styles.resultDetail}>for {phoneNumber}</Text>
          <Text style={styles.resultAmount}>
            {formatNaira(selectedBundle?.amount ?? 0)}
          </Text>
          <TouchableOpacity style={styles.primaryButton} onPress={handleDismissResult}>
            <Text style={styles.primaryButtonText}>{Strings.BUTTON_DONE}</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          ref={scrollRef}
          style={styles.scrollView}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <TouchableOpacity
            style={styles.backButton}
            activeOpacity={0.6}
            onPress={() => { Keyboard.dismiss(); navigation.goBack(); }}
          >
            <Text style={styles.backText}>{'<'}</Text>
          </TouchableOpacity>

          <Text style={styles.title}>Buy Data</Text>

          {pickerMode !== 'closed' && (
            <ContactPickerModal
              visible
              multiSelect={pickerMode === 'multi'}
              onClose={() => setPickerMode('closed')}
              onSelect={handleContactSelect}
              onSelectMultiple={handleBulkContactsSelected}
            />
          )}

          <View style={styles.section}>
            <Text style={styles.recipientHeading}>Choose recipients</Text>
            <View style={styles.contactActions}>
              <TouchableOpacity
                style={styles.contactActionCard}
                onPress={() => setPickerMode('single')}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel="Choose one phone number from your contacts"
              >
                <View style={styles.contactActionIcon}>
                  <Ionicons name="person" size={24} color="#FFFFFF" />
                </View>
                <Text style={styles.contactActionTitle}>Choose one contact</Text>
                <Text style={styles.contactActionDescription}>Pick a saved number</Text>
                <View style={styles.contactActionButton}>
                  <Text style={styles.contactActionButtonText}>Choose</Text>
                  <Ionicons name="arrow-forward" size={18} color="#FFFFFF" />
                </View>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.contactActionCard}
                onPress={() => setPickerMode('multi')}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel="Select multiple phone numbers from your contacts"
              >
                <View style={styles.contactActionIcon}>
                  <Ionicons name="people" size={24} color="#FFFFFF" />
                </View>
                <Text style={styles.contactActionTitle}>Send to many</Text>
                <Text style={styles.contactActionDescription}>Select multiple contacts</Text>
                <View style={styles.contactActionButton}>
                  <Text style={styles.contactActionButtonText}>Select</Text>
                  <Ionicons name="arrow-forward" size={18} color="#FFFFFF" />
                </View>
              </TouchableOpacity>
            </View>

            <Text style={styles.label}>Phone Number</Text>
            <TextInput
              style={styles.phoneInput}
              value={phoneNumber}
              onChangeText={handlePhoneChange}
              placeholder={Strings.PHONE_INPUT_PLACEHOLDER}
              placeholderTextColor={theme.inkMuted}
              keyboardType="phone-pad"
            />
            {detectedNetwork && detectedNetwork.network !== 'Unknown' && (
              <View style={styles.detectedBadge}>
                <View
                  style={[styles.detectedDot, { backgroundColor: detectedNetwork.color }]}
                />
                <Text style={styles.detectedText}>Detected: {detectedNetwork.network}</Text>
              </View>
            )}
          </View>

          <View style={styles.section}>
            <Text style={styles.label}>Select Network</Text>
            {/* Same reasoning as AirtimeScreen's equivalent block — an
                unrecognized or ported prefix leaves effectiveNetwork null
                with no explanation otherwise visible near the chips. */}
            {isValidPhoneFormat(phoneNumber.replace(/\D/g, '')) && !effectiveNetwork && (
              <View style={styles.undetectedBadge}>
                <Text style={styles.undetectedText}>
                  We couldn't detect this number's network automatically — please select it below.
                </Text>
              </View>
            )}
            <View style={styles.networkChips}>
              {NETWORKS.map(({ key, label }) => {
                const isSelected =
                  selectedNetwork === key ||
                  (!selectedNetwork && autoDetectedNetwork === key);
                return (
                  <TouchableOpacity
                    key={key}
                    style={[
                      styles.networkChip,
                      isSelected && { borderColor: NETWORK_COLORS[key] },
                    ]}
                    onPress={() => handleNetworkSelect(key)}
                  >
                    <ProviderLogo source={NETWORK_LOGOS[key]} fallbackLabel={label} size={32} />
                    <Text
                      style={[
                        styles.networkChipText,
                        isSelected && { color: NETWORK_COLORS[key] },
                      ]}
                    >
                      {label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>

          {effectiveNetwork && (catalogBusy || displayedBundles.length > 0) && (
            <View style={styles.section}>
              <Text style={styles.label}>Choose a Bundle</Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.bundleFilters}
              >
                {BUNDLE_FILTERS.map((filter) => {
                  const active = bundleFilter === filter.key;
                  return (
                    <TouchableOpacity
                      key={filter.key}
                      accessibilityRole="button"
                      accessibilityState={{ selected: active }}
                      style={[styles.bundleFilterChip, active && styles.bundleFilterChipActive]}
                      onPress={() => setBundleFilter(filter.key)}
                    >
                      <Text style={[styles.bundleFilterText, active && styles.bundleFilterTextActive]}>
                        {filter.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
              {catalogBusy ? (
                <View style={styles.catalogLoadingRow}>
                  <ActivityIndicator size="small" color={theme.brand} />
                  <Text style={styles.catalogLoadingText}>
                    {catalogTransitioning
                      ? `Loading ${networkLabel(effectiveNetwork)} bundles…`
                      : 'Updating reseller prices…'}
                  </Text>
                </View>
              ) : null}
              {filteredBundles.map((bundle) => {
                const isSelected = selectedBundle?.id === bundle.id;
                const hasDiscount = !!bundle.list_amount && bundle.list_amount > bundle.amount;
                const presentation = bundlePresentation(bundle);
                return (
                  <TouchableOpacity
                    key={bundle.id}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: isSelected }}
                    accessibilityLabel={`${presentation.title}, ${bundle.validity}, pay ${formatNaira(bundle.amount)}`}
                    style={[
                      styles.bundleCard,
                      presentation.warning && styles.bundleCardWarning,
                      isSelected && styles.bundleCardSelected,
                    ]}
                    onPress={() => handleBundleSelect(bundle)}
                  >
                    <View style={styles.bundleInfo}>
                      <Text style={styles.bundleName} numberOfLines={2}>{presentation.title}</Text>
                      <View style={styles.bundleMetaRow}>
                        {presentation.category && (
                          <View style={styles.categoryBadge}>
                            <Text style={styles.categoryBadgeText}>{presentation.category}</Text>
                          </View>
                        )}
                        <Ionicons name="time-outline" size={14} color={theme.inkMuted} />
                        <Text style={styles.bundleValidity}>{bundle.validity}</Text>
                      </View>
                      {presentation.warning && (
                        <View style={styles.bundleWarningRow}>
                          <Ionicons name="warning" size={14} color={Colors.AMBER} />
                          <Text style={styles.bundleWarningText} numberOfLines={2}>{presentation.warning}</Text>
                        </View>
                      )}
                      {(hasDiscount || bundle.has_cashback) && (
                        <View style={styles.badgeRow}>
                          {hasDiscount && (
                            <View style={styles.discountBadge}>
                              <Text style={styles.discountBadgeText}>
                                Save {formatNaira((bundle.list_amount as number) - bundle.amount)}
                              </Text>
                            </View>
                          )}
                          {bundle.has_cashback && (
                            <View style={styles.cashbackBadge}>
                              <Text style={styles.cashbackBadgeText}>+ Cashback</Text>
                            </View>
                          )}
                        </View>
                      )}
                    </View>
                    <View style={styles.bundleAmountColumn}>
                      <View style={[styles.radioOuter, isSelected && styles.radioOuterSelected]}>
                        {isSelected && <View style={styles.radioInner} />}
                      </View>
                      {hasDiscount && (
                        <Text style={styles.bundleListAmount}>{formatNaira(bundle.list_amount as number)}</Text>
                      )}
                      <Text
                        style={[
                          styles.bundleAmount,
                          isSelected && styles.bundleAmountSelected,
                        ]}
                      >
                        Pay {formatNaira(bundle.amount)}
                      </Text>
                    </View>
                  </TouchableOpacity>
                );
              })}
              {filteredBundles.length === 0 && !catalogBusy && (
                <View style={styles.filteredEmptyState}>
                  <Text style={styles.filteredEmptyText}>No {bundleFilter} bundles are currently available.</Text>
                </View>
              )}
            </View>
          )}

          {!effectiveNetwork && phoneNumber.replace(/\D/g, '').length >= 4 && (
            <View style={styles.emptyState}>
              <Text style={styles.emptyStateText}>
                {Strings.NETWORK_UNKNOWN}. Select a network manually above.
              </Text>
            </View>
          )}

          {effectiveNetwork && displayedBundles.length === 0 && !catalogBusy && (
            <View style={styles.emptyState}>
              <Text style={styles.emptyStateText}>
                No bundles available for {networkLabel(effectiveNetwork)}
              </Text>
            </View>
          )}

          {errorMessage ? (
            <View style={styles.errorContainer}>
              <Text style={styles.errorText}>{errorMessage}</Text>
            </View>
          ) : null}
        </ScrollView>

        <View style={[styles.bottomBar, { paddingBottom: insets.bottom + Spacing.L }]}>
          {selectedBundle && (
            <View style={styles.summary}>
              <Text style={styles.summaryText}>
                {selectedBundle.name}{' • '}
                {effectiveNetwork ? networkLabel(effectiveNetwork) : ''}{' • '}
                {selectedBundle.validity}
              </Text>
              <View style={styles.bundleAmountColumn}>
                {cashbackApplied > 0 ? (
                  <>
                    <Text style={styles.bundleListAmount}>{formatNaira(selectedBundle.amount)}</Text>
                    <Text style={styles.summaryAmount}>{formatNaira(walletAmount)}</Text>
                  </>
                ) : (
                  <>
                    {!!selectedBundle.list_amount && selectedBundle.list_amount > selectedBundle.amount && (
                      <Text style={styles.bundleListAmount}>{formatNaira(selectedBundle.list_amount)}</Text>
                    )}
                    <Text style={styles.summaryAmount}>
                      {formatNaira(selectedBundle.amount)}
                    </Text>
                  </>
                )}
              </View>
            </View>
          )}

          {selectedBundle && cashbackBalance > 0 && (
            <View style={styles.cashbackToggleRow}>
              <View style={styles.cashbackToggleLabel}>
                <View style={styles.cashbackToggleBadge}>
                  <Ionicons name="gift" size={18} color="#FFFFFF" />
                </View>
                <View style={styles.cashbackToggleTextCol}>
                  <Text style={styles.cashbackToggleTitle}>Use your cashback</Text>
                  <Text style={styles.cashbackToggleSubtitle}>
                    {formatNaira(cashbackBalance)} available
                    {useCashback && cashbackApplied > 0 ? (
                      <Text style={styles.cashbackToggleApplied}> • {formatNaira(cashbackApplied)} applied</Text>
                    ) : ''}
                  </Text>
                </View>
              </View>
              <Switch
                value={useCashback}
                onValueChange={setUseCashback}
                trackColor={{ false: theme.surfaceRaised, true: theme.brand }}
                thumbColor="#FFFFFF"
              />
            </View>
          )}

          {payHint && (
            <View style={styles.payHintRow}>
              <Text style={styles.payHintText}>{payHint}</Text>
            </View>
          )}
          <TouchableOpacity
            style={[
              styles.primaryButton,
              (!selectedBundle || buyState === 'processing') &&
                styles.primaryButtonDisabled,
            ]}
            onPress={handleBuy}
            disabled={!selectedBundle || buyState === 'processing'}
          >
            {buyState === 'processing' ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <View style={styles.payButtonTextColumn}>
                <Text style={styles.primaryButtonText}>Pay</Text>
                {cashbackApplied > 0 && walletAmount === 0 && (
                  <Text style={styles.payButtonSubtext}>No new cashback earned on a cashback-funded order</Text>
                )}
              </View>
            )}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.background,
  },
  flex: {
    flex: 1,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: Spacing.SCREEN_PADDING,
    paddingTop: Spacing.M,
    // See ExamPinsScreen.tsx's identical comment — 120 only fit the Pay
    // button alone; a hint line above it could push it taller than that,
    // hiding content behind it with no way to scroll past.
    paddingBottom: 180,
  },
  backButton: {
    width: 48,
    height: 48,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: Spacing.XL,
  },
  backText: {
    fontSize: 28,
    fontWeight: '600',
    color: theme.ink,
  },
  title: {
    ...Typography.SCREEN_TITLE,
    color: theme.ink,
    marginBottom: Spacing.L,
  },
  section: {
    marginBottom: Spacing.XL,
  },
  kycGate: {
    alignItems: 'center',
    paddingTop: Spacing.XL,
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
  kycGateButton: {
    width: '100%',
  },
  label: {
    ...Typography.SECTION_HEADING,
    color: theme.ink,
    marginBottom: Spacing.M,
  },
  recipientHeading: {
    ...Typography.SECTION_HEADING,
    color: theme.ink,
    marginBottom: Spacing.M,
  },
  contactActions: {
    flexDirection: 'row',
    gap: Spacing.M,
    marginBottom: Spacing.L,
  },
  contactActionCard: {
    flex: 1,
    minHeight: 156,
    gap: Spacing.S,
    padding: Spacing.L,
    borderRadius: Spacing.BUTTON_RADIUS,
    borderWidth: 1,
    borderColor: theme.brand,
    backgroundColor: theme.brandSoft,
    boxShadow: '0 2px 4px rgba(15, 61, 39, 0.10)',
  },
  contactActionIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: theme.brand,
    alignItems: 'center',
    justifyContent: 'center',
  },
  contactActionTitle: {
    ...Typography.CARD_TITLE,
    fontSize: 13,
    lineHeight: 18,
    color: theme.ink,
  },
  contactActionDescription: {
    ...Typography.CAPTION,
    fontSize: 11,
    lineHeight: 16,
    color: theme.inkMuted,
  },
  contactActionButton: {
    minHeight: Spacing.TOUCH_TARGET_MIN,
    marginTop: 'auto',
    borderRadius: Spacing.TOUCH_TARGET_MIN / 2,
    backgroundColor: theme.brand,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.M,
  },
  contactActionButtonText: {
    ...Typography.BUTTON_TEXT,
    fontSize: 13,
  },
  phoneInput: {
    height: Spacing.INPUT_HEIGHT,
    borderWidth: Spacing.INPUT_BORDER_WIDTH,
    borderColor: theme.border,
    borderRadius: Spacing.BUTTON_RADIUS,
    paddingHorizontal: Spacing.L,
    ...Typography.BODY,
    color: theme.ink,
  },
  detectedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: Spacing.S,
  },
  detectedDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: Spacing.S,
  },
  detectedText: {
    ...Typography.CAPTION,
    color: theme.brand,
  },
  undetectedBadge: {
    marginBottom: Spacing.M,
    padding: Spacing.S,
    backgroundColor: '#FEF3C7',
    borderRadius: 8,
  },
  undetectedText: {
    ...Typography.CAPTION,
    color: '#92400E',
    fontWeight: '600',
  },
  networkChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.M,
  },
  networkChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.S,
    height: Spacing.TOUCH_TARGET_MIN,
    paddingHorizontal: Spacing.M,
    borderRadius: Spacing.TOUCH_TARGET_MIN / 2,
    borderWidth: 1.5,
    borderColor: theme.border,
    backgroundColor: theme.surface,
  },
  networkChipText: {
    ...Typography.BODY,
    fontSize: 13,
    color: theme.ink,
  },
  bundleFilters: {
    gap: Spacing.S,
    paddingBottom: Spacing.M,
  },
  bundleFilterChip: {
    minWidth: 68,
    minHeight: Spacing.TOUCH_TARGET_MIN,
    paddingHorizontal: Spacing.M,
    borderRadius: Spacing.TOUCH_TARGET_MIN / 2,
    borderWidth: 1,
    borderColor: theme.brand,
    backgroundColor: theme.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bundleFilterChipActive: {
    backgroundColor: theme.brand,
  },
  bundleFilterText: {
    ...Typography.CAPTION,
    fontWeight: '700',
    color: theme.brand,
  },
  bundleFilterTextActive: {
    color: '#FFFFFF',
  },
  bundleCard: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'stretch',
    minHeight: 104,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: Spacing.CARD_RADIUS,
    paddingHorizontal: Spacing.M,
    paddingVertical: Spacing.S + 2,
    marginBottom: Spacing.S + 2,
    backgroundColor: theme.surface,
  },
  bundleCardWarning: {
    minHeight: 122,
  },
  catalogLoadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.S,
    marginBottom: Spacing.M,
  },
  catalogLoadingText: {
    color: theme.inkMuted,
    fontSize: 12,
  },
  bundleCardSelected: {
    borderColor: theme.brand,
    borderWidth: 2,
    backgroundColor: theme.brandSoft,
  },
  bundleInfo: {
    flex: 1,
    paddingRight: Spacing.S,
    justifyContent: 'center',
  },
  bundleName: {
    ...Typography.CARD_TITLE,
    color: theme.ink,
    fontSize: 15,
    lineHeight: 19,
  },
  bundleMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 5,
    marginTop: 4,
  },
  categoryBadge: {
    backgroundColor: theme.brandSoft,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
  },
  categoryBadgeText: {
    fontSize: 10,
    lineHeight: 13,
    fontWeight: '700',
    color: theme.brand,
  },
  bundleValidity: {
    ...Typography.CAPTION,
    fontSize: 11,
    color: theme.inkMuted,
  },
  bundleWarningRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 4,
    marginTop: 5,
  },
  bundleWarningText: {
    flex: 1,
    fontSize: 10,
    lineHeight: 13,
    fontWeight: '600',
    color: Colors.AMBER,
  },
  badgeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 6,
  },
  discountBadge: {
    backgroundColor: theme.brandSoft,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 5,
  },
  discountBadgeText: {
    fontSize: 10,
    fontWeight: '600',
    color: theme.brand,
  },
  cashbackBadge: {
    backgroundColor: '#FEF3C7',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 5,
  },
  cashbackBadgeText: {
    fontSize: 10,
    fontWeight: '600',
    color: Colors.AMBER,
  },
  bundleAmountColumn: {
    alignItems: 'flex-end',
    justifyContent: 'center',
    minWidth: 88,
    gap: 2,
  },
  radioOuter: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: theme.inkMuted,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 2,
  },
  radioOuterSelected: {
    borderColor: theme.brand,
  },
  radioInner: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: theme.brand,
  },
  bundleListAmount: {
    ...Typography.CAPTION,
    color: theme.inkMuted,
    textDecorationLine: 'line-through',
  },
  bundleAmount: {
    ...Typography.AMOUNT_SMALL,
    fontSize: 15,
    color: theme.ink,
  },
  bundleAmountSelected: {
    color: theme.brand,
  },
  filteredEmptyState: {
    minHeight: 64,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Spacing.CARD_RADIUS,
    backgroundColor: theme.surfaceRaised,
    paddingHorizontal: Spacing.M,
  },
  filteredEmptyText: {
    ...Typography.CAPTION,
    color: theme.inkMuted,
    textAlign: 'center',
  },
  emptyState: {
    height: 80,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: theme.surfaceRaised,
    borderRadius: Spacing.CARD_RADIUS,
  },
  emptyStateText: {
    ...Typography.BODY,
    color: theme.inkMuted,
    textAlign: 'center',
    paddingHorizontal: Spacing.XL,
  },
  errorContainer: {
    marginTop: Spacing.M,
  },
  errorText: {
    ...Typography.ERROR,
  },
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
  summary: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: Spacing.L,
  },
  summaryText: {
    ...Typography.BODY,
    color: theme.ink,
    flex: 1,
  },
  summaryAmount: {
    ...Typography.AMOUNT_SMALL,
    color: theme.ink,
  },
  cashbackToggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#FEF3C7',
    borderWidth: 1.5,
    borderColor: 'rgba(245, 158, 11, 0.45)',
    borderRadius: 14,
    paddingHorizontal: Spacing.M,
    paddingVertical: Spacing.S + 2,
    marginBottom: Spacing.M,
    shadowColor: Colors.AMBER,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.22,
    shadowRadius: 10,
    elevation: 3,
  },
  cashbackToggleLabel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.S + 3,
    flex: 1,
  },
  cashbackToggleBadge: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: Colors.AMBER,
    justifyContent: 'center',
    alignItems: 'center',
  },
  cashbackToggleTextCol: {
    flex: 1,
  },
  cashbackToggleTitle: {
    ...Typography.CARD_TITLE,
    fontWeight: '800',
    color: '#78350F',
  },
  cashbackToggleSubtitle: {
    ...Typography.CAPTION,
    color: '#92640A',
    marginTop: 1,
  },
  cashbackToggleApplied: {
    color: theme.brand,
    fontWeight: '700',
  },
  payButtonTextColumn: {
    alignItems: 'center',
  },
  payButtonSubtext: {
    fontSize: 11,
    color: '#FFFFFF',
    opacity: 0.8,
    marginTop: 1,
  },
  payHintRow: {
    marginBottom: Spacing.M,
    alignItems: 'center',
  },
  payHintText: {
    ...Typography.CAPTION,
    color: theme.inkMuted,
    textAlign: 'center',
  },
  primaryButton: {
    height: Spacing.BUTTON_HEIGHT_PRIMARY,
    backgroundColor: theme.brand,
    borderRadius: Spacing.BUTTON_RADIUS,
    justifyContent: 'center',
    alignItems: 'center',
  },
  primaryButtonDisabled: {
    opacity: 0.5,
  },
  primaryButtonText: {
    ...Typography.BUTTON_TEXT,
  },
  resultContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: Spacing.SCREEN_PADDING,
  },
  successIcon: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: theme.brand,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: Spacing.XL,
  },
  successIconText: {
    fontSize: 36,
    color: '#FFFFFF',
  },
  resultTitle: {
    ...Typography.SCREEN_TITLE,
    color: theme.ink,
    marginBottom: Spacing.M,
  },
  resultDetail: {
    ...Typography.BODY,
    color: theme.inkMuted,
    marginBottom: Spacing.S,
  },
  resultAmount: {
    ...Typography.AMOUNT_LARGE,
    color: theme.brand,
    marginTop: Spacing.L,
    marginBottom: Spacing.XL,
  },
  });
}
