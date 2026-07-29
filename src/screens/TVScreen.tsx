import React, { useState, useCallback, useMemo } from 'react';
import {
  View,
  StyleSheet,
  Text,
  KeyboardAvoidingView,
  Platform,
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
import { vtuService, type TVProvider } from '../services/vtu.service';
import { useTransactionAuth } from '../components/TransactionAuthProvider';
import ProviderLogo from '../components/ProviderLogo';
import { TV_LOGOS } from '../utils/providerLogos';

interface TVScreenProps {
  navigation: any;
}

type BuyState = 'idle' | 'processing' | 'success' | 'error';

interface Bouquet {
  id: string;
  name: string;
  amount: number;
}

export default function TVScreen({ navigation }: TVScreenProps) {
  const { authorize } = useTransactionAuth();
  const insets = useSafeAreaInsets();
  const [selectedProvider, setSelectedProvider] = useState<TVProvider | null>(null);
  const [selectedBouquet, setSelectedBouquet] = useState<Bouquet | null>(null);
  const [smartcardNumber, setSmartcardNumber] = useState('');
  const [buyState, setBuyState] = useState<BuyState>('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const [resultPending, setResultPending] = useState(false);

  const providers = useMemo(() => vtuService.getTVProviders(), []);

  const bouquets = useMemo(() => {
    if (!selectedProvider) return [];
    return selectedProvider.bouquets;
  }, [selectedProvider]);

  const handleProviderSelect = useCallback((provider: TVProvider) => {
    setSelectedProvider((prev) => (prev?.id === provider.id ? null : provider));
    setSelectedBouquet(null);
  }, []);

  const handleBouquetSelect = useCallback((bouquet: Bouquet) => {
    setSelectedBouquet((prev) => (prev?.id === bouquet.id ? null : bouquet));
  }, []);

  const handleSmartcardChange = useCallback((text: string) => {
    const digits = text.replace(/\D/g, '').slice(0, 13);
    setSmartcardNumber(digits);
  }, []);

  const handleBuy = useCallback(async () => {
    if (!selectedProvider) {
      setErrorMessage('Please select a TV provider');
      return;
    }

    if (!selectedBouquet) {
      setErrorMessage('Please select a bouquet');
      return;
    }

    const digits = smartcardNumber.replace(/\D/g, '');
    if (digits.length < 8) {
      setErrorMessage('Please enter a valid smartcard number');
      return;
    }

    const authResult = await authorize({ title: 'Confirm TV Subscription', amount: selectedBouquet.amount });
    if (!authResult) return;

    setErrorMessage('');
    // Go STRAIGHT to the result screen — it runs the purchase itself and shows
    // Processing -> Successful. No spinner on the Pay button first.
    navigation.navigate('TransactionStatus', {
      title: 'TV Subscription',
      amount: selectedBouquet.amount,
      recipient: digits,
      paymentMethod: 'Balance',
      request: {
        kind: 'tv',
        providerId: selectedProvider.id,
        smartcardNumber: digits,
        bouquetId: selectedBouquet.id,
        amount: selectedBouquet.amount,
        authToken: authResult.token,
      },
    });
  }, [selectedProvider, selectedBouquet, smartcardNumber, navigation, authorize]);

  const handleDismissResult = useCallback(() => {
    setBuyState('idle');
    setErrorMessage('');
    setSelectedProvider(null);
    setSelectedBouquet(null);
    setSmartcardNumber('');
    setResultPending(false);
  }, []);

  const isValidSmartcard = useMemo(
    () => smartcardNumber.replace(/\D/g, '').length >= 8,
    [smartcardNumber],
  );
  const canProceed = !!selectedProvider && !!selectedBouquet && isValidSmartcard && buyState !== 'processing';

  // The single next thing the user must do before Pay can proceed — so the
  // greyed button is never a silent dead end. null once everything's ready.
  const payHint = useMemo(() => {
    if (buyState === 'processing') return null;
    if (!selectedProvider) return 'Select a TV provider to continue';
    if (!selectedBouquet) return 'Choose a bouquet to continue';
    if (!isValidSmartcard) return 'Enter your smartcard number';
    return null;
  }, [buyState, selectedProvider, selectedBouquet, isValidSmartcard]);

  if (buyState === 'success') {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.resultContainer}>
          <View style={styles.successIcon}>
            <Text style={styles.successIconText}>{'✓'}</Text>
          </View>
          <Text style={styles.resultTitle}>
            {resultPending ? 'Order Processing' : 'Payment Successful'}
          </Text>
          {resultPending && (
            <Text style={styles.resultDetail}>You'll be notified once it completes.</Text>
          )}
          <Text style={styles.resultDetail}>
            {selectedBouquet?.name} on {selectedProvider?.name}
          </Text>
          <Text style={styles.resultDetail}>Smartcard: {smartcardNumber}</Text>
          <Text style={styles.resultAmount}>
            {formatNaira(selectedBouquet?.amount ?? 0)}
          </Text>
          <TouchableOpacity
            style={styles.primaryButton}
            onPress={handleDismissResult}
          >
            <Text style={styles.primaryButtonText}>Done</Text>
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
          style={styles.scrollView}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <TouchableOpacity
            style={styles.backButton}
            activeOpacity={0.6}
            onPress={() => navigation.goBack()}
          >
            <Text style={styles.backText}>{'<'}</Text>
          </TouchableOpacity>

          <Text style={styles.title}>TV Subscription</Text>

          <View style={styles.section}>
            <Text style={styles.label}>Select Provider</Text>
            <View style={styles.providerGrid}>
              {providers.map((provider) => {
                const isSelected = selectedProvider?.id === provider.id;
                return (
                  <TouchableOpacity
                    key={provider.id}
                    style={[
                      styles.providerCard,
                      isSelected && styles.providerCardSelected,
                    ]}
                    onPress={() => handleProviderSelect(provider)}
                  >
                    <ProviderLogo
                      source={TV_LOGOS[provider.id]}
                      fallbackLabel={provider.name}
                      size={36}
                      style={styles.providerCardLogo}
                    />
                    <Text
                      style={[
                        styles.providerCardText,
                        isSelected && styles.providerCardTextSelected,
                      ]}
                    >
                      {provider.name}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>

          {bouquets.length > 0 && (
            <View style={styles.section}>
              <Text style={styles.label}>Choose a Bouquet</Text>
              {bouquets.map((bouquet) => {
                const isSelected = selectedBouquet?.id === bouquet.id;
                return (
                  <TouchableOpacity
                    key={bouquet.id}
                    style={[
                      styles.bundleCard,
                      isSelected && styles.bundleCardSelected,
                    ]}
                    onPress={() => handleBouquetSelect(bouquet)}
                  >
                    <View style={styles.bundleInfo}>
                      <Text style={styles.bundleName}>{bouquet.name}</Text>
                      <Text style={styles.bundleProvider}>{selectedProvider?.name}</Text>
                    </View>
                    <Text
                      style={[
                        styles.bundleAmount,
                        isSelected && styles.bundleAmountSelected,
                      ]}
                    >
                      {formatNaira(bouquet.amount)}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          )}

          {selectedProvider && bouquets.length === 0 && (
            <View style={styles.emptyState}>
              <Text style={styles.emptyStateText}>
                No bouquets available for {selectedProvider.name}
              </Text>
            </View>
          )}

          <View style={styles.section}>
            <Text style={styles.label}>Smartcard Number</Text>
            <TextInput
              style={styles.input}
              value={smartcardNumber}
              onChangeText={handleSmartcardChange}
              placeholder="Enter smartcard number"
              placeholderTextColor={Colors.GRAY}
              keyboardType="phone-pad"
              maxLength={13}
            />
          </View>

          {errorMessage ? (
            <View style={styles.errorContainer}>
              <Text style={styles.errorText}>{errorMessage}</Text>
            </View>
          ) : null}
        </ScrollView>

        <View style={[styles.bottomBar, { paddingBottom: insets.bottom + Spacing.L }]}>
          {selectedBouquet && (
            <View style={styles.summary}>
              <Text style={styles.summaryText}>
                {selectedProvider?.name}{' \u2022 '}{selectedBouquet.name}
              </Text>
              <Text style={styles.summaryAmount}>
                {formatNaira(selectedBouquet.amount)}
              </Text>
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
              !canProceed && styles.primaryButtonDisabled,
            ]}
            onPress={handleBuy}
            disabled={!canProceed}
          >
            {buyState === 'processing' ? (
              <ActivityIndicator color={Colors.WHITE} />
            ) : (
              <Text style={styles.primaryButtonText}>Pay</Text>
            )}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.WHITE,
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
    paddingBottom: 120,
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
  providerGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.M,
  },
  providerCard: {
    width: '47%',
    paddingVertical: Spacing.L,
    borderWidth: 1,
    borderColor: Colors.BORDER,
    borderRadius: Spacing.CARD_RADIUS,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: Colors.WHITE,
  },
  providerCardLogo: {
    marginBottom: Spacing.S,
  },
  providerCardSelected: {
    borderColor: Colors.GREEN,
    borderWidth: 2,
    backgroundColor: Colors.GREEN_10,
  },
  providerCardText: {
    ...Typography.CARD_TITLE,
    fontSize: 15,
    color: Colors.DARK,
  },
  providerCardTextSelected: {
    color: Colors.GREEN,
  },
  bundleCard: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    height: Spacing.LIST_ITEM_HEIGHT,
    borderWidth: 1,
    borderColor: Colors.BORDER,
    borderRadius: Spacing.CARD_RADIUS,
    paddingHorizontal: Spacing.CARD_PADDING,
    marginBottom: Spacing.M,
  },
  bundleCardSelected: {
    borderColor: Colors.GREEN,
    borderWidth: 2,
    backgroundColor: Colors.GREEN_10,
  },
  bundleInfo: {
    flex: 1,
  },
  bundleName: {
    ...Typography.CARD_TITLE,
    marginBottom: 2,
  },
  bundleProvider: {
    ...Typography.CAPTION,
  },
  bundleAmount: {
    ...Typography.AMOUNT_SMALL,
    color: Colors.DARK,
  },
  bundleAmountSelected: {
    color: Colors.GREEN,
  },
  emptyState: {
    height: 80,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: Colors.LIGHT_GRAY,
    borderRadius: Spacing.CARD_RADIUS,
  },
  emptyStateText: {
    ...Typography.BODY,
    color: Colors.GRAY,
    textAlign: 'center',
    paddingHorizontal: Spacing.XL,
  },
  input: {
    height: Spacing.INPUT_HEIGHT,
    borderWidth: Spacing.INPUT_BORDER_WIDTH,
    borderColor: Colors.BORDER,
    borderRadius: Spacing.BUTTON_RADIUS,
    paddingHorizontal: Spacing.L,
    ...Typography.BODY,
    color: Colors.DARK,
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
  payHintRow: { marginBottom: Spacing.M, alignItems: 'center' },
  payHintText: { ...Typography.CAPTION, color: Colors.GRAY, textAlign: 'center' },
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
    flex: 1,
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
  },
  resultAmount: {
    ...Typography.AMOUNT_LARGE,
    color: Colors.GREEN,
    marginTop: Spacing.L,
    marginBottom: Spacing.XL,
  },
});
