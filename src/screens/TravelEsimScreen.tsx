import React, { useState, useCallback, useMemo } from 'react';
import {
  View,
  StyleSheet,
  Text,
  Image,
  ScrollView,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  Modal,
  Linking,
  Platform,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Colors } from '../constants/colors';
import { Typography } from '../constants/typography';
import { Spacing } from '../constants/spacing';
import { formatNaira } from '../utils/formatCurrency';
import {
  esimService,
  flagFromCode,
  type EsimCountry,
  type EsimPlan,
  type MyEsim,
} from '../services/esim.service';
import { useCachedData } from '../hooks/useCachedData';
import { useTransactionAuth } from '../components/TransactionAuthProvider';

interface TravelEsimScreenProps {
  navigation: {
    goBack: () => void;
  };
}

type BuyState = 'idle' | 'processing' | 'success' | 'error';

export default function TravelEsimScreen({ navigation }: TravelEsimScreenProps) {
  const { authorize } = useTransactionAuth();
  const insets = useSafeAreaInsets();

  // Country list is 100% live from the provider (no hardcoded list). The cache
  // layer shows the last-known-good list instantly and keeps it on screen if a
  // refresh fails, so a network blip never leaves the browser empty.
  const {
    data: countries,
    loading: countriesLoading,
    error: countriesError,
    refresh: refreshCountries,
  } = useCachedData<EsimCountry[]>('esim_countries', () => esimService.loadCountries());

  const { data: myEsims, refresh: refreshMyEsims } = useCachedData<MyEsim[]>(
    'esim_my_esims',
    () => esimService.getMyEsims(),
  );

  const [countrySearch, setCountrySearch] = useState('');
  const filteredCountries = useMemo(() => {
    const list = countries || [];
    const q = countrySearch.trim().toLowerCase();
    if (!q) return list;
    return list.filter((c) => c.name.toLowerCase().includes(q));
  }, [countries, countrySearch]);

  const countryName = useCallback(
    (code: string) => (countries || []).find((c) => c.code === code)?.name || code,
    [countries],
  );

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

  // A previously-bought eSIM whose QR the user tapped to reopen.
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
        setBuyState('success');
        // Pull the freshly-bought eSIM into "My eSIMs".
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
  }, []);

  if (buyState === 'success') {
    return (
      <SafeAreaView style={styles.container}>
        <ScrollView contentContainerStyle={styles.resultContainer} showsVerticalScrollIndicator={false}>
          <View style={styles.successIcon}>
            <Text style={styles.successIconText}>{'✓'}</Text>
          </View>
          <Text style={styles.resultTitle}>
            {resultPending ? 'eSIM Processing' : 'eSIM Ready'}
          </Text>
          {resultPending ? (
            <Text style={styles.resultDetail}>
              {resultMessage || "You'll be notified once it's ready. Check My eSIMs for updates."}
            </Text>
          ) : (
            <>
              <Text style={styles.resultDetail}>{selectedCountry?.name}</Text>
              <Text style={styles.resultDetail}>{selectedPlan?.name}</Text>
              {resultQrUrl && (
                <View style={styles.qrContainer}>
                  <Image source={{ uri: resultQrUrl }} style={styles.qrImage} resizeMode="contain" />
                  <Text style={styles.qrHint}>Scan this QR code in your phone's eSIM settings to install</Text>
                </View>
              )}
            </>
          )}
          <TouchableOpacity style={styles.primaryButton} onPress={handleDismissResult}>
            <Text style={styles.primaryButtonText}>Done</Text>
          </TouchableOpacity>
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <TouchableOpacity
          style={styles.backButton}
          activeOpacity={0.6}
          onPress={() => (selectedCountry ? handleDismissResult() : navigation.goBack())}
        >
          <Text style={styles.backText}>{'<'}</Text>
        </TouchableOpacity>

        <Text style={styles.title}>Travel eSIM</Text>

        {!selectedCountry ? (
          <>
            {myEsims && myEsims.length > 0 && (
              <View style={styles.section}>
                <Text style={styles.label}>My eSIMs</Text>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.myEsimRow}
                >
                  {myEsims.map((e) => (
                    <TouchableOpacity
                      key={e.id}
                      style={styles.myEsimCard}
                      onPress={() => setViewingEsim(e)}
                      activeOpacity={0.7}
                    >
                      <Text style={styles.myEsimFlag}>{flagFromCode(e.countryCode)}</Text>
                      <Text style={styles.myEsimName} numberOfLines={1}>
                        {countryName(e.countryCode)}
                      </Text>
                      <Text style={styles.myEsimView}>View QR</Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              </View>
            )}

            <View style={styles.section}>
              <Text style={styles.label}>Browse plans</Text>
              <TextInput
                style={styles.searchInput}
                value={countrySearch}
                onChangeText={setCountrySearch}
                placeholder="Search country..."
                placeholderTextColor={Colors.GRAY}
              />
              {!countries && countriesLoading ? (
                <View style={styles.loadingContainer}>
                  <ActivityIndicator color={Colors.GREEN} />
                  <Text style={styles.loadingText}>Loading destinations...</Text>
                </View>
              ) : !countries && countriesError ? (
                <View style={styles.loadingContainer}>
                  <Text style={styles.amountError}>Could not load destinations.</Text>
                  <TouchableOpacity style={styles.retryButton} onPress={refreshCountries}>
                    <Text style={styles.retryButtonText}>Retry</Text>
                  </TouchableOpacity>
                </View>
              ) : filteredCountries.length === 0 ? (
                <Text style={styles.amountError}>No countries match "{countrySearch}"</Text>
              ) : (
                <View style={styles.countryGrid}>
                  {filteredCountries.map((country) => (
                    <TouchableOpacity
                      key={country.code}
                      style={styles.countryCard}
                      onPress={() => handleCountrySelect(country)}
                      activeOpacity={0.7}
                    >
                      <Text style={styles.countryFlag}>{country.flag}</Text>
                      <Text style={styles.countryName} numberOfLines={1}>{country.name}</Text>
                      {country.fromKobo != null && (
                        <Text style={styles.countryPrice} numberOfLines={1}>
                          from {formatNaira(country.fromKobo / 100)}
                        </Text>
                      )}
                    </TouchableOpacity>
                  ))}
                </View>
              )}
            </View>
          </>
        ) : (
          <View style={styles.section}>
            <View style={styles.selectedCountryChip}>
              <Text style={styles.countryFlag}>{selectedCountry.flag}</Text>
              <Text style={styles.selectedCountryName}>{selectedCountry.name}</Text>
            </View>

            <Text style={styles.label}>Select a plan</Text>

            {loadingPlans ? (
              <View style={styles.loadingContainer}>
                <ActivityIndicator color={Colors.GREEN} />
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
              {selectedCountry?.name} · {esimService.formatDataAmount(selectedPlan.dataMB)} / {selectedPlan.days}d
            </Text>
            <Text style={styles.summaryAmount}>{formatNaira(selectedPlan.priceKobo / 100)}</Text>
          </View>
          <TouchableOpacity
            style={[styles.primaryButton, buyState === 'processing' && styles.primaryButtonDisabled]}
            onPress={handlePay}
            disabled={buyState === 'processing'}
          >
            {buyState === 'processing' ? (
              <ActivityIndicator color={Colors.WHITE} />
            ) : (
              <Text style={styles.primaryButtonText}>
                Buy {formatNaira(selectedPlan.priceKobo / 100)}
              </Text>
            )}
          </TouchableOpacity>
        </View>
      )}

      {/* Reopen a previously-bought eSIM's QR */}
      <Modal visible={!!viewingEsim} transparent animationType="slide" onRequestClose={() => setViewingEsim(null)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalSheet}>
            <View style={styles.modalHandle} />
            <Text style={styles.resultTitle}>{viewingEsim ? countryName(viewingEsim.countryCode) : ''} eSIM</Text>
            {viewingEsim?.qrcodeUrl && (
              <View style={styles.qrContainer}>
                <Image source={{ uri: viewingEsim.qrcodeUrl }} style={styles.qrImage} resizeMode="contain" />
              </View>
            )}
            <Text style={styles.qrHint}>
              Scan this QR on the phone you want the eSIM on: Settings → Cellular / Mobile → Add eSIM.
            </Text>
            {viewingEsim?.iccid ? (
              <Text style={styles.iccidText}>ICCID: {viewingEsim.iccid}</Text>
            ) : null}
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

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.WHITE,
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
    color: Colors.DARK,
  },
  title: {
    ...Typography.SCREEN_TITLE,
    marginBottom: Spacing.L,
  },
  section: {
    marginBottom: Spacing.XL,
  },
  label: {
    ...Typography.SECTION_HEADING,
    marginBottom: Spacing.M,
  },
  myEsimRow: {
    gap: Spacing.M,
    paddingRight: Spacing.M,
  },
  myEsimCard: {
    width: 120,
    backgroundColor: Colors.GREEN_10,
    borderWidth: 1,
    borderColor: Colors.GREEN,
    borderRadius: Spacing.CARD_RADIUS,
    padding: Spacing.CARD_PADDING,
    alignItems: 'center',
  },
  myEsimFlag: {
    fontSize: 28,
    marginBottom: Spacing.S,
  },
  myEsimName: {
    ...Typography.BODY,
    fontSize: 13,
    fontWeight: '600',
    color: Colors.DARK,
    textAlign: 'center',
  },
  myEsimView: {
    ...Typography.CAPTION,
    color: Colors.GREEN,
    fontWeight: '700',
    marginTop: 4,
  },
  searchInput: {
    height: Spacing.INPUT_HEIGHT,
    borderWidth: Spacing.INPUT_BORDER_WIDTH,
    borderColor: Colors.BORDER,
    borderRadius: Spacing.BUTTON_RADIUS,
    paddingHorizontal: Spacing.L,
    ...Typography.BODY,
    color: Colors.DARK,
    marginBottom: Spacing.M,
  },
  countryGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.M,
  },
  countryCard: {
    width: '30%',
    backgroundColor: Colors.WHITE,
    borderWidth: 1,
    borderColor: Colors.BORDER,
    borderRadius: Spacing.CARD_RADIUS,
    padding: Spacing.CARD_PADDING,
    alignItems: 'center',
  },
  countryFlag: {
    fontSize: 32,
    marginBottom: Spacing.S,
  },
  countryName: {
    ...Typography.BODY,
    fontSize: 12,
    textAlign: 'center',
    color: Colors.DARK,
  },
  countryPrice: {
    ...Typography.CAPTION,
    fontSize: 11,
    color: Colors.GREEN,
    fontWeight: '700',
    marginTop: 4,
  },
  selectedCountryChip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.GREEN_LIGHT,
    borderRadius: Spacing.BUTTON_RADIUS,
    paddingVertical: Spacing.S,
    paddingHorizontal: Spacing.M,
    marginBottom: Spacing.L,
    alignSelf: 'flex-start',
  },
  selectedCountryName: {
    ...Typography.BODY,
    color: Colors.GREEN_DARK,
    fontWeight: '600',
    marginLeft: Spacing.S,
  },
  loadingContainer: {
    alignItems: 'center',
    paddingVertical: Spacing.XL,
  },
  loadingText: {
    ...Typography.CAPTION,
    color: Colors.GRAY,
    marginTop: Spacing.M,
  },
  retryButton: {
    marginTop: Spacing.M,
    paddingVertical: Spacing.S,
    paddingHorizontal: Spacing.L,
    borderRadius: Spacing.BUTTON_RADIUS,
    borderWidth: 1,
    borderColor: Colors.GREEN,
  },
  retryButtonText: {
    ...Typography.BODY,
    color: Colors.GREEN,
    fontWeight: '600',
  },
  plansContainer: {
    gap: Spacing.M,
  },
  planCard: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: Colors.WHITE,
    borderWidth: 1,
    borderColor: Colors.BORDER,
    borderRadius: Spacing.CARD_RADIUS,
    padding: Spacing.CARD_PADDING,
  },
  planCardSelected: {
    borderColor: Colors.GREEN,
    borderWidth: 2,
    backgroundColor: Colors.GREEN_10,
  },
  planInfo: {
    flex: 1,
  },
  planData: {
    ...Typography.CARD_TITLE,
    color: Colors.DARK,
  },
  planDataSelected: {
    color: Colors.GREEN_DARK,
  },
  planDays: {
    ...Typography.CAPTION,
    color: Colors.GRAY,
    marginTop: 2,
  },
  planPrice: {
    ...Typography.AMOUNT_SMALL,
  },
  planPriceSelected: {
    color: Colors.GREEN,
  },
  amountError: {
    ...Typography.ERROR,
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
    backgroundColor: Colors.WHITE,
    borderTopWidth: 1,
    borderTopColor: Colors.BORDER,
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
    flex: 1,
  },
  summaryAmount: {
    ...Typography.AMOUNT_SMALL,
  },
  primaryButton: {
    height: Spacing.BUTTON_HEIGHT_PRIMARY,
    backgroundColor: Colors.GREEN,
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
    backgroundColor: Colors.GREEN,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: Spacing.XL,
  },
  successIconText: {
    fontSize: 36,
    color: Colors.WHITE,
  },
  resultTitle: {
    ...Typography.SCREEN_TITLE,
    marginBottom: Spacing.M,
    textAlign: 'center',
  },
  resultDetail: {
    ...Typography.BODY,
    color: Colors.GRAY,
    marginBottom: Spacing.S,
    textAlign: 'center',
  },
  qrContainer: {
    alignItems: 'center',
    marginTop: Spacing.L,
    marginBottom: Spacing.L,
  },
  qrImage: {
    width: 220,
    height: 220,
    marginBottom: Spacing.M,
  },
  qrHint: {
    ...Typography.CAPTION,
    color: Colors.GRAY,
    textAlign: 'center',
    paddingHorizontal: Spacing.L,
  },
  iccidText: {
    ...Typography.CAPTION,
    color: Colors.DARK,
    textAlign: 'center',
    marginTop: Spacing.S,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: Colors.OVERLAY,
    justifyContent: 'flex-end',
  },
  modalSheet: {
    backgroundColor: Colors.WHITE,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: Spacing.L,
    paddingTop: Spacing.S,
    paddingBottom: Spacing.XL,
    alignItems: 'center',
  },
  modalHandle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: Colors.BORDER,
    alignSelf: 'center',
    marginBottom: Spacing.M,
  },
  modalClose: {
    height: Spacing.BUTTON_HEIGHT_PRIMARY,
    borderRadius: Spacing.BUTTON_RADIUS,
    borderWidth: 1,
    borderColor: Colors.BORDER,
    justifyContent: 'center',
    alignItems: 'center',
    alignSelf: 'stretch',
    marginTop: Spacing.M,
  },
  modalCloseText: {
    ...Typography.BUTTON_TEXT,
    color: Colors.DARK,
  },
});
