import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import {
  View,
  StyleSheet,
  Text,
  ScrollView,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  BackHandler,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppTheme } from '../constants/theme';
import { useTheme } from '../components/ThemeProvider';
import { Typography } from '../constants/typography';
import { Spacing } from '../constants/spacing';
import { formatNaira } from '../utils/formatCurrency';
import { useSensitiveScreenProtection } from '../hooks/useSensitiveScreenProtection';
import {
  foreignNumberService,
  type ForeignNumberService as FNService,
  type ForeignNumberCountry,
  type AvailableCountry,
} from '../services/foreignNumber.service';
import { useTransactionAuth } from '../components/TransactionAuthProvider';

interface ForeignNumbersScreenProps {
  navigation: {
    goBack: () => void;
  };
}

type Step = 'service' | 'country' | 'confirm' | 'waiting' | 'done';

const POLL_INTERVAL_MS = 4000;

// 2-letter country code → flag emoji (SMSPVA uses "UK" for the UK, not "GB").
function countryFlag(code: string): string {
  const cc = (code === 'UK' ? 'GB' : code || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return '';
  return String.fromCodePoint(...[...cc].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65));
}

export default function ForeignNumbersScreen({ navigation }: ForeignNumbersScreenProps) {
  useSensitiveScreenProtection();
  const { authorize } = useTransactionAuth();
  const { theme } = useTheme();
  const styles = createStyles(theme);
  const insets = useSafeAreaInsets();
  const services = useMemo(() => foreignNumberService.getServices(), []);

  // Countries that actually have the chosen service in stock (fetched per
  // service), so the user never picks an unavailable one.
  const [availableCountries, setAvailableCountries] = useState<AvailableCountry[]>([]);
  const [loadingCountries, setLoadingCountries] = useState(false);
  const [countriesError, setCountriesError] = useState('');

  const [step, setStep] = useState<Step>('service');
  const [selectedService, setSelectedService] = useState<FNService | null>(null);
  const [selectedCountry, setSelectedCountry] = useState<ForeignNumberCountry | null>(null);
  const [serviceSearch, setServiceSearch] = useState('');
  const [countrySearch, setCountrySearch] = useState('');
  const [countrySort, setCountrySort] = useState<'cheapest' | 'az'>('cheapest');
  const [fromPrices, setFromPrices] = useState<Record<string, number>>({});

  const [showAllServices, setShowAllServices] = useState(false);
  const [allServices, setAllServices] = useState<FNService[]>([]);
  const [loadingAllServices, setLoadingAllServices] = useState(false);
  const [allServicesError, setAllServicesError] = useState('');

  const [loadingPrice, setLoadingPrice] = useState(false);
  const [priceError, setPriceError] = useState('');
  const [priceKobo, setPriceKobo] = useState<number | null>(null);
  const [available, setAvailable] = useState<number | null>(null);

  const [purchasing, setPurchasing] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  const [activationId, setActivationId] = useState<string | null>(null);
  const [phoneNumber, setPhoneNumber] = useState('');
  const [receivedCode, setReceivedCode] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const [waitMessage, setWaitMessage] = useState('');

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Load each service's "from ₦X" starting price once, for the service picker.
  useEffect(() => {
    foreignNumberService.getServiceFromPrices().then(setFromPrices).catch(() => {});
  }, []);

  const filteredCountries = useMemo(() => {
    const q = countrySearch.trim().toLowerCase();
    const base = q ? availableCountries.filter((c) => c.name.toLowerCase().includes(q)) : availableCountries;
    return [...base].sort((a, b) =>
      countrySort === 'cheapest' ? a.priceKobo - b.priceKobo : a.name.localeCompare(b.name),
    );
  }, [availableCountries, countrySearch, countrySort]);

  // Curated popular list, or (in "browse all" mode) the full ~2,400-service
  // catalog filtered by search and capped so we never render thousands of
  // rows at once.
  const ALL_SERVICES_CAP = 80;
  const filteredServices = useMemo(() => {
    const source = showAllServices ? allServices : services;
    const q = serviceSearch.trim().toLowerCase();
    const filtered = q ? source.filter((s) => s.name.toLowerCase().includes(q)) : source;
    return showAllServices ? filtered.slice(0, ALL_SERVICES_CAP) : filtered;
  }, [showAllServices, allServices, services, serviceSearch]);

  const allServicesTruncated = useMemo(() => {
    if (!showAllServices) return false;
    const q = serviceSearch.trim().toLowerCase();
    const total = q ? allServices.filter((s) => s.name.toLowerCase().includes(q)).length : allServices.length;
    return total > ALL_SERVICES_CAP;
  }, [showAllServices, allServices, serviceSearch]);

  const handleBrowseAll = useCallback(async () => {
    setShowAllServices(true);
    setServiceSearch('');
    if (allServices.length > 0) return; // already loaded this session
    setLoadingAllServices(true);
    setAllServicesError('');
    const result = await foreignNumberService.getAllServices();
    setLoadingAllServices(false);
    if (result.success && result.services) {
      setAllServices(result.services);
    } else {
      setAllServicesError(result.error || 'Could not load services');
    }
  }, [allServices.length]);

  const handleBackToPopular = useCallback(() => {
    setShowAllServices(false);
    setServiceSearch('');
    setAllServicesError('');
  }, []);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  // Picking a service loads ONLY the countries that have it in stock (with
  // live prices), so the next screen is a guaranteed-available list.
  const handleServiceSelect = useCallback(async (service: FNService) => {
    setSelectedService(service);
    setStep('country');
    setShowAllServices(false);
    setCountrySearch('');
    setSelectedCountry(null);
    setPriceKobo(null);
    setAvailable(null);
    setPriceError('');
    setAvailableCountries([]);
    setCountriesError('');
    setLoadingCountries(true);

    const result = await foreignNumberService.getCountriesForService(service.id);
    setLoadingCountries(false);
    if (!result.success) {
      setCountriesError(result.error || 'Could not load countries. Please try again.');
      return;
    }
    setAvailableCountries(result.countries || []);
  }, []);

  // The list is served from a price cache (fast), so a country can be listed
  // but momentarily out of stock. Re-check LIVE at selection so a sold-out
  // country is caught here — before the user pays — not at purchase.
  const handleCountrySelect = useCallback(async (country: AvailableCountry) => {
    setSelectedCountry({ id: country.id, name: country.name });
    setPriceKobo(country.priceKobo); // show the list price immediately
    setAvailable(null);
    setPriceError('');
    setStep('confirm');
    setLoadingPrice(true);
    const result = await foreignNumberService.getPrice(selectedService?.id ?? '', country.id);
    setLoadingPrice(false);
    if (result.success && result.priceKobo != null) {
      setPriceKobo(result.priceKobo);
      setAvailable(result.available ?? null);
    } else {
      setPriceError(result.error || 'This country just sold out. Please pick another.');
    }
  }, [selectedService]);

  const startPolling = useCallback((id: string) => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      const result = await foreignNumberService.checkStatus(id);
      if (!result.success || !result.done) return;

      if (pollRef.current) clearInterval(pollRef.current);

      if (result.cancelled) {
        setWaitMessage(
          result.refunded
            ? 'No code arrived, so this number was cancelled and your wallet has been refunded. You can try another number or country.'
            : 'This number was cancelled by the provider. If you were charged, tap cancel to request a refund.',
        );
        return;
      }
      if (result.code) {
        setReceivedCode(result.code);
        setStep('done');
      }
    }, POLL_INTERVAL_MS);
  }, []);

  const handlePurchase = useCallback(async () => {
    if (!selectedService || !selectedCountry || priceKobo === null || purchasing) return;

    const authResult = await authorize({ title: 'Confirm Foreign Number Purchase', amount: priceKobo / 100 });
    if (!authResult) return;

    setErrorMessage('');
    setPurchasing(true);

    try {
      const result = await foreignNumberService.purchase(selectedService.id, selectedCountry.id, authResult.token, selectedService.name, priceKobo ?? undefined);

      if (result.success && result.activation_id && result.phone_number) {
        setActivationId(result.activation_id);
        setPhoneNumber(result.phone_number);
        setStep('waiting');
        startPolling(result.activation_id);
      } else {
        setErrorMessage(result.error || 'Purchase failed. Please try again.');
      }
    } catch {
      setErrorMessage('An unexpected error occurred. Please check your connection and try again.');
    } finally {
      setPurchasing(false);
    }
  }, [selectedService, selectedCountry, priceKobo, purchasing, authorize, startPolling]);

  const handleCancel = useCallback(async () => {
    if (!activationId || cancelling) return;

    Alert.alert(
      'Cancel and Give Up Waiting?',
      "If no code has arrived, we'll try to refund you — but this isn't always guaranteed by the provider.",
      [
        { text: 'Keep Waiting', style: 'cancel' },
        {
          text: 'Cancel Number',
          style: 'destructive',
          onPress: async () => {
            setCancelling(true);
            if (pollRef.current) clearInterval(pollRef.current);

            const result = await foreignNumberService.cancel(activationId);

            setCancelling(false);
            Alert.alert(
              result.refunded ? 'Cancelled & Refunded' : 'Cancelled',
              result.message || (result.refunded ? 'Your wallet has been refunded.' : 'Could not confirm a refund for this purchase.'),
              [{ text: 'OK', onPress: handleReset }],
            );
          },
        },
      ],
    );
  }, [activationId, cancelling]);

  const handleReset = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    setStep('service');
    setSelectedService(null);
    setSelectedCountry(null);
    setShowAllServices(false);
    setServiceSearch('');
    setCountrySearch('');
    setAvailableCountries([]);
    setCountriesError('');
    setPriceKobo(null);
    setAvailable(null);
    setPriceError('');
    setErrorMessage('');
    setActivationId(null);
    setPhoneNumber('');
    setReceivedCode('');
    setWaitMessage('');
  }, []);

  const handleBack = useCallback(() => {
    if (step === 'confirm') {
      setStep('country');
      setSelectedCountry(null);
      setPriceKobo(null);
      setAvailable(null);
      setPriceError('');
      return;
    }
    if (step === 'country') {
      setStep('service');
      setSelectedService(null);
      return;
    }
    if (step === 'service' && showAllServices) {
      handleBackToPopular();
      return;
    }
    navigation.goBack();
  }, [step, navigation, showAllServices, handleBackToPopular]);

  // Make the phone's hardware/gesture back button step BACK through the flow
  // (like the on-screen "<"), instead of popping the whole screen to Home. It
  // only leaves the screen when already at the first step (service picker).
  useEffect(() => {
    const onHardwareBack = () => {
      if (step === 'service' && !showAllServices) return false; // let it exit to Home
      handleBack();
      return true; // consumed — we handled it in-screen
    };
    const sub = BackHandler.addEventListener('hardwareBackPress', onHardwareBack);
    return () => sub.remove();
  }, [step, showAllServices, handleBack]);

  if (step === 'done') {
    return (
      <SafeAreaView style={styles.container}>
        <ScrollView contentContainerStyle={styles.resultContainer} showsVerticalScrollIndicator={false}>
          <View style={styles.successIcon}>
            <Text style={styles.successIconText}>{'✓'}</Text>
          </View>
          <Text style={styles.resultTitle}>Code Received</Text>
          <Text style={styles.resultDetail}>{selectedService?.name} · {selectedCountry?.name}</Text>
          <Text style={styles.resultDetail}>{`+${phoneNumber.replace(/^\++/, '')}`}</Text>
          <View style={styles.codeContainer}>
            <Text style={styles.codeLabel}>Verification Code</Text>
            <Text style={styles.codeValue}>{receivedCode}</Text>
          </View>
          <TouchableOpacity style={styles.primaryButton} onPress={handleReset}>
            <Text style={styles.primaryButtonText}>Done</Text>
          </TouchableOpacity>
        </ScrollView>
      </SafeAreaView>
    );
  }

  if (step === 'waiting') {
    return (
      <SafeAreaView style={styles.container}>
        <ScrollView contentContainerStyle={styles.resultContainer} showsVerticalScrollIndicator={false}>
          <ActivityIndicator size="large" color={theme.brand} style={styles.waitingSpinner} />
          <Text style={styles.resultTitle}>Waiting for Code</Text>
          <Text style={styles.resultDetail}>{selectedService?.name} · {selectedCountry?.name}</Text>
          <View style={styles.phoneContainer}>
            <Text style={styles.codeLabel}>Your Temporary Number</Text>
            <Text style={styles.phoneValue} selectable>{`+${phoneNumber.replace(/^\++/, '')}`}</Text>
          </View>
          <Text style={styles.waitHint}>
            Use this number to request a verification code on {selectedService?.name}. It'll appear here automatically once it arrives. If no code comes within a few minutes, tap below to cancel and get an instant refund.
          </Text>
          {waitMessage ? <Text style={styles.amountError}>{waitMessage}</Text> : null}
          <TouchableOpacity
            style={styles.cancelButton}
            onPress={handleCancel}
            disabled={cancelling}
          >
            {cancelling ? (
              <ActivityIndicator color={theme.down} size="small" />
            ) : (
              <Text style={styles.cancelButtonText}>No Code Received / Cancel</Text>
            )}
          </TouchableOpacity>
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      <KeyboardAvoidingView style={styles.scrollView} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          style={styles.scrollView}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'}
        >
        <TouchableOpacity style={styles.backButton} activeOpacity={0.6} onPress={handleBack}>
          <Text style={styles.backText}>{'<'}</Text>
        </TouchableOpacity>

        <Text style={styles.title}>Foreign Number</Text>

        {step === 'service' && (
          <View style={styles.section}>
            <Text style={styles.label}>
              {showAllServices ? 'Browse all services' : 'Which service do you need a number for?'}
            </Text>
            <TextInput
              style={styles.searchInput}
              value={serviceSearch}
              onChangeText={setServiceSearch}
              placeholder={showAllServices ? 'Search all services...' : 'Search service (WhatsApp, Telegram...)'}
              placeholderTextColor={theme.inkMuted}
            />

            {showAllServices && loadingAllServices ? (
              <View style={styles.loadingContainer}>
                <ActivityIndicator color={theme.brand} />
                <Text style={styles.loadingText}>Loading all services...</Text>
              </View>
            ) : showAllServices && allServicesError ? (
              <>
                <Text style={styles.amountError}>{allServicesError}</Text>
                <TouchableOpacity style={styles.secondaryButton} onPress={handleBrowseAll}>
                  <Text style={styles.secondaryButtonText}>Retry</Text>
                </TouchableOpacity>
              </>
            ) : (
              <View style={styles.countryList}>
                {filteredServices.map((service) => (
                  <TouchableOpacity
                    key={service.id}
                    style={styles.countryRow}
                    onPress={() => handleServiceSelect(service)}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.countryName}>{service.name}</Text>
                    <View style={styles.countryRight}>
                      {fromPrices[service.id] ? (
                        <Text style={styles.fromPrice}>from {formatNaira(fromPrices[service.id] / 100)}</Text>
                      ) : null}
                      <Text style={styles.countryArrow}>{'>'}</Text>
                    </View>
                  </TouchableOpacity>
                ))}
                {filteredServices.length === 0 && (
                  <Text style={styles.loadingText}>
                    {showAllServices ? 'No matching service. Try a different search.' : 'No matching service.'}
                  </Text>
                )}
                {allServicesTruncated && (
                  <Text style={styles.loadingText}>
                    Showing the first {ALL_SERVICES_CAP} — type to narrow the search.
                  </Text>
                )}
              </View>
            )}

            {!showAllServices ? (
              <TouchableOpacity style={styles.browseAllButton} onPress={handleBrowseAll} activeOpacity={0.7}>
                <Text style={styles.browseAllText}>
                  Can't find it? Browse all services →
                </Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity style={styles.secondaryButton} onPress={handleBackToPopular}>
                <Text style={styles.secondaryButtonText}>← Back to popular services</Text>
              </TouchableOpacity>
            )}
          </View>
        )}

        {step === 'country' && (
          <View style={styles.section}>
            <Text style={styles.label}>
              {selectedService?.name} — available countries
            </Text>

            {loadingCountries ? (
              <View style={styles.loadingContainer}>
                <ActivityIndicator color={theme.brand} />
                <Text style={styles.loadingText}>
                  Finding countries with {selectedService?.name} in stock...
                </Text>
              </View>
            ) : countriesError ? (
              <>
                <Text style={styles.amountError}>{countriesError}</Text>
                <TouchableOpacity
                  style={styles.secondaryButton}
                  onPress={() => selectedService && handleServiceSelect(selectedService)}
                >
                  <Text style={styles.secondaryButtonText}>Retry</Text>
                </TouchableOpacity>
              </>
            ) : availableCountries.length === 0 ? (
              <View style={styles.loadingContainer}>
                <Text style={styles.emptyTitle}>No country available</Text>
                <Text style={styles.loadingText}>
                  {selectedService?.name} has no numbers in stock in any country right now. Try another service.
                </Text>
                <TouchableOpacity style={styles.secondaryButton} onPress={handleBack}>
                  <Text style={styles.secondaryButtonText}>Pick another service</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <>
                <TextInput
                  style={styles.searchInput}
                  value={countrySearch}
                  onChangeText={setCountrySearch}
                  placeholder="Search country..."
                  placeholderTextColor={theme.inkMuted}
                />
                <View style={styles.sortRow}>
                  <Text style={styles.sortLabel}>Sort:</Text>
                  <TouchableOpacity
                    style={[styles.sortChip, countrySort === 'cheapest' && styles.sortChipActive]}
                    onPress={() => setCountrySort('cheapest')}
                    activeOpacity={0.7}
                  >
                    <Text style={[styles.sortChipText, countrySort === 'cheapest' && styles.sortChipTextActive]}>Cheapest</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.sortChip, countrySort === 'az' && styles.sortChipActive]}
                    onPress={() => setCountrySort('az')}
                    activeOpacity={0.7}
                  >
                    <Text style={[styles.sortChipText, countrySort === 'az' && styles.sortChipTextActive]}>A–Z</Text>
                  </TouchableOpacity>
                </View>
                <View style={styles.countryList}>
                  {filteredCountries.map((country) => (
                    <TouchableOpacity
                      key={country.id}
                      style={styles.countryRow}
                      onPress={() => handleCountrySelect(country)}
                      activeOpacity={0.7}
                    >
                      <Text style={styles.countryName}>{countryFlag(country.id)}  {country.name}</Text>
                      <View style={styles.countryRight}>
                        <Text style={styles.countryPrice}>{formatNaira(country.priceKobo / 100)}</Text>
                        <Text style={styles.countryArrow}>{'>'}</Text>
                      </View>
                    </TouchableOpacity>
                  ))}
                  {filteredCountries.length === 0 && (
                    <Text style={styles.loadingText}>No matching country.</Text>
                  )}
                </View>
              </>
            )}
          </View>
        )}

        {step === 'confirm' && (
          <View style={styles.section}>
            {selectedService ? (
              <View style={styles.summaryCard}>
                <Text style={styles.summaryRow}>{selectedService.name}</Text>
                <Text style={styles.summaryRowSub}>{selectedCountry?.name}</Text>
              </View>
            ) : null}

            {loadingPrice ? (
              <View style={styles.loadingContainer}>
                <ActivityIndicator color={theme.brand} />
                <Text style={styles.loadingText}>
                  Checking {selectedService?.name} availability in {selectedCountry?.name}...
                </Text>
              </View>
            ) : priceError ? (
              <>
                <Text style={styles.amountError}>{priceError}</Text>
                <TouchableOpacity style={styles.secondaryButton} onPress={handleBack}>
                  <Text style={styles.secondaryButtonText}>Pick another country</Text>
                </TouchableOpacity>
              </>
            ) : priceKobo !== null ? (
              <>
                <View style={styles.priceCard}>
                  <Text style={styles.priceLabel}>Price</Text>
                  <Text style={styles.priceValue}>{formatNaira(priceKobo / 100)}</Text>
                </View>
                {available !== null && (
                  <Text style={styles.stockText}>
                    ✓ In stock{available > 0 ? ` · ${available.toLocaleString()} available` : ''}
                  </Text>
                )}
                <Text style={styles.disclaimer}>
                  One-time number — it receives a single code, then expires in about 15 minutes. If no code arrives, you're refunded automatically. Once a code is received, the purchase can't be refunded.
                </Text>
              </>
            ) : null}

            {errorMessage ? (
              <View style={styles.errorContainer}>
                <Text style={styles.errorText}>{errorMessage}</Text>
              </View>
            ) : null}
          </View>
        )}
        </ScrollView>
      </KeyboardAvoidingView>

      {step === 'confirm' && priceKobo !== null && (
        <View style={[styles.bottomBar, { paddingBottom: insets.bottom + Spacing.L }]}>
          <TouchableOpacity
            style={[styles.primaryButton, purchasing && styles.primaryButtonDisabled]}
            onPress={handlePurchase}
            disabled={purchasing}
          >
            {purchasing ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={styles.primaryButtonText}>Get Number · {formatNaira(priceKobo / 100)}</Text>
            )}
          </TouchableOpacity>
        </View>
      )}
    </SafeAreaView>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.background,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: Spacing.SCREEN_PADDING,
    paddingTop: Spacing.M,
    paddingBottom: 140,
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
  label: {
    ...Typography.SECTION_HEADING,
    color: theme.ink,
    marginBottom: Spacing.M,
  },
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
  countryList: {
    borderRadius: Spacing.CARD_RADIUS,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: theme.border,
  },
  countryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: Spacing.M,
    paddingVertical: Spacing.M,
    borderBottomWidth: 1,
    borderBottomColor: theme.border,
    backgroundColor: theme.surface,
  },
  countryName: {
    ...Typography.BODY,
    color: theme.ink,
    flex: 1,
  },
  countryRight: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  countryPrice: {
    ...Typography.BODY,
    color: theme.brand,
    fontWeight: '600',
    marginRight: Spacing.M,
  },
  fromPrice: {
    ...Typography.CAPTION,
    color: theme.brand,
    fontWeight: '600',
    marginRight: Spacing.M,
  },
  sortRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: Spacing.S,
    marginBottom: Spacing.S,
  },
  sortLabel: {
    ...Typography.CAPTION,
    color: theme.inkMuted,
    marginRight: Spacing.S,
  },
  sortChip: {
    paddingHorizontal: Spacing.M,
    paddingVertical: Spacing.XS,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: theme.border,
    marginRight: Spacing.S,
    backgroundColor: theme.surface,
  },
  sortChipActive: {
    backgroundColor: theme.brandSoft,
    borderColor: theme.brand,
  },
  sortChipText: {
    ...Typography.CAPTION,
    color: theme.inkMuted,
    fontWeight: '600',
  },
  sortChipTextActive: {
    color: theme.brand,
  },
  emptyTitle: {
    ...Typography.SECTION_HEADING,
    color: theme.ink,
    marginBottom: Spacing.S,
    textAlign: 'center',
  },
  countryArrow: {
    ...Typography.BODY,
    color: theme.inkMuted,
  },
  summaryCard: {
    backgroundColor: theme.brandSoft,
    borderRadius: Spacing.CARD_RADIUS,
    padding: Spacing.CARD_PADDING,
    marginBottom: Spacing.L,
  },
  summaryRow: {
    ...Typography.CARD_TITLE,
    color: theme.brand,
  },
  summaryRowSub: {
    ...Typography.CAPTION,
    color: theme.brand,
    marginTop: 2,
  },
  loadingContainer: {
    alignItems: 'center',
    paddingVertical: Spacing.XL,
  },
  loadingText: {
    ...Typography.CAPTION,
    color: theme.inkMuted,
    marginTop: Spacing.M,
  },
  priceCard: {
    backgroundColor: theme.surfaceRaised,
    borderRadius: Spacing.CARD_RADIUS,
    padding: Spacing.CARD_PADDING,
    alignItems: 'center',
    marginBottom: Spacing.M,
  },
  priceLabel: {
    ...Typography.CAPTION,
    color: theme.inkMuted,
    marginBottom: Spacing.S,
  },
  priceValue: {
    ...Typography.AMOUNT_LARGE,
    color: theme.brand,
  },
  stockText: {
    ...Typography.CAPTION,
    color: theme.brand,
    fontWeight: '600',
    textAlign: 'center',
    marginBottom: Spacing.M,
  },
  secondaryButton: {
    height: Spacing.BUTTON_HEIGHT_SECONDARY,
    borderRadius: Spacing.BUTTON_RADIUS,
    borderWidth: 1,
    borderColor: theme.brand,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: Spacing.M,
  },
  secondaryButtonText: {
    ...Typography.BUTTON_TEXT,
    color: theme.brand,
  },
  browseAllButton: {
    paddingVertical: Spacing.M,
    alignItems: 'center',
    marginTop: Spacing.S,
  },
  browseAllText: {
    ...Typography.BODY,
    color: theme.brand,
    fontWeight: '600',
  },
  disclaimer: {
    ...Typography.CAPTION,
    color: theme.inkMuted,
    textAlign: 'center',
  },
  amountError: {
    ...Typography.ERROR,
    textAlign: 'center',
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
    flexGrow: 1,
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
  waitingSpinner: {
    marginBottom: Spacing.XL,
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
    textAlign: 'center',
  },
  codeContainer: {
    backgroundColor: theme.surfaceRaised,
    borderRadius: Spacing.CARD_RADIUS,
    padding: Spacing.CARD_PADDING,
    width: '100%',
    alignItems: 'center',
    marginTop: Spacing.L,
    marginBottom: Spacing.XL,
  },
  phoneContainer: {
    backgroundColor: theme.surfaceRaised,
    borderRadius: Spacing.CARD_RADIUS,
    padding: Spacing.CARD_PADDING,
    width: '100%',
    alignItems: 'center',
    marginTop: Spacing.L,
    marginBottom: Spacing.M,
  },
  codeLabel: {
    ...Typography.CAPTION,
    color: theme.inkMuted,
    marginBottom: Spacing.S,
  },
  codeValue: {
    ...Typography.CODE,
    color: theme.brand,
    letterSpacing: 2,
    fontSize: 28,
  },
  phoneValue: {
    ...Typography.CODE,
    color: theme.ink,
    letterSpacing: 1,
  },
  waitHint: {
    ...Typography.CAPTION,
    color: theme.inkMuted,
    textAlign: 'center',
    marginBottom: Spacing.XL,
    paddingHorizontal: Spacing.M,
  },
  cancelButton: {
    height: Spacing.BUTTON_HEIGHT_SECONDARY,
    paddingHorizontal: Spacing.L,
    borderRadius: Spacing.BUTTON_RADIUS,
    borderWidth: 1,
    borderColor: theme.down,
    justifyContent: 'center',
    alignItems: 'center',
  },
  cancelButtonText: {
    ...Typography.BUTTON_TEXT,
    color: theme.down,
    fontSize: 14,
  },
  });
}
