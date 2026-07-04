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
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Colors } from '../constants/colors';
import { Typography } from '../constants/typography';
import { Spacing } from '../constants/spacing';
import { formatNaira } from '../utils/formatCurrency';
import { esimService, type EsimCountry, type EsimPlan } from '../services/esim.service';
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
  const countries = useMemo(() => esimService.getCountries(), []);
  const [countrySearch, setCountrySearch] = useState('');
  const filteredCountries = useMemo(() => {
    const q = countrySearch.trim().toLowerCase();
    if (!q) return countries;
    return countries.filter((c) => c.name.toLowerCase().includes(q));
  }, [countries, countrySearch]);

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

  const handleCountrySelect = useCallback(async (country: EsimCountry) => {
    setSelectedCountry(country);
    setSelectedPlan(null);
    setPlans([]);
    setPlansError('');
    setLoadingPlans(true);

    const result = await esimService.browsePlans(country.code);

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
      const result = await esimService.buyPlan(selectedPlan.id, selectedCountry.code, authResult.token);

      if (result.success) {
        setResultPending(!!result.pending);
        setResultMessage(result.message || '');
        setResultQrUrl(result.qrcode_url || null);
        setBuyState('success');
      } else {
        setErrorMessage(result.error || 'eSIM purchase failed. Please try again.');
        setBuyState('error');
      }
    } catch {
      setErrorMessage('An unexpected error occurred. Please check your connection and try again.');
      setBuyState('error');
    }
  }, [selectedPlan, selectedCountry, buyState, authorize]);

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
              {resultMessage || "You'll be notified once it's ready. Check Transaction History for updates."}
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
          <View style={styles.section}>
            <Text style={styles.label}>Where are you traveling?</Text>
            <TextInput
              style={styles.searchInput}
              value={countrySearch}
              onChangeText={setCountrySearch}
              placeholder="Search country..."
              placeholderTextColor={Colors.GRAY}
            />
            {filteredCountries.length === 0 ? (
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
                  </TouchableOpacity>
                ))}
              </View>
            )}
          </View>
        ) : (
          <View style={styles.section}>
            <View style={styles.selectedCountryChip}>
              <Text style={styles.countryFlag}>{selectedCountry.flag}</Text>
              <Text style={styles.selectedCountryName}>{selectedCountry.name}</Text>
            </View>

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
});
