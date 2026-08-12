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
  Alert,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { Colors } from '../constants/colors';
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
import { useTransactionAuth } from '../components/TransactionAuthProvider';
import ContactPickerModal from '../components/ContactPickerModal';
import ProviderLogo from '../components/ProviderLogo';
import { PickedContact } from '../services/contacts.service';
import { NETWORK_LOGOS } from '../utils/providerLogos';
import { isRestrictedPlanName } from '../utils/planWarnings';

interface DataScreenProps {
  navigation: any;
}

type BuyState = 'idle' | 'processing' | 'success' | 'error';

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

function networkLabel(network: NetworkProvider): string {
  return NETWORKS.find((n) => n.key === network)?.label ?? network;
}

export default function DataScreen({ navigation }: DataScreenProps) {
  const { authorize } = useTransactionAuth();
  const insets = useSafeAreaInsets();
  const [phoneNumber, setPhoneNumber] = useState('');
  const [selectedNetwork, setSelectedNetwork] = useState<NetworkProvider | null>(null);
  const [selectedBundle, setSelectedBundle] = useState<DataBundle | null>(null);
  const [buyState, setBuyState] = useState<BuyState>('idle');
  const [resultPending, setResultPending] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [pickerMode, setPickerMode] = useState<'closed' | 'single' | 'multi'>('closed');
  const [bundles, setBundles] = useState<DataBundle[]>([]);
  const [bundlesNetwork, setBundlesNetwork] = useState<NetworkProvider | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);

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

    const authResult = await authorize({ title: 'Confirm Data Purchase', amount: selectedBundle.amount });
    if (!authResult) return;

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
      },
    });
  }, [phoneNumber, effectiveNetwork, selectedBundle, authorize, navigation]);

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
                  <Ionicons name="person" size={24} color={Colors.WHITE} />
                </View>
                <Text style={styles.contactActionTitle}>Choose one contact</Text>
                <Text style={styles.contactActionDescription}>Pick a saved number</Text>
                <View style={styles.contactActionButton}>
                  <Text style={styles.contactActionButtonText}>Choose</Text>
                  <Ionicons name="arrow-forward" size={18} color={Colors.WHITE} />
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
                  <Ionicons name="people" size={24} color={Colors.WHITE} />
                </View>
                <Text style={styles.contactActionTitle}>Send to many</Text>
                <Text style={styles.contactActionDescription}>Select multiple contacts</Text>
                <View style={styles.contactActionButton}>
                  <Text style={styles.contactActionButtonText}>Select</Text>
                  <Ionicons name="arrow-forward" size={18} color={Colors.WHITE} />
                </View>
              </TouchableOpacity>
            </View>

            <Text style={styles.label}>Phone Number</Text>
            <TextInput
              style={styles.phoneInput}
              value={phoneNumber}
              onChangeText={handlePhoneChange}
              placeholder={Strings.PHONE_INPUT_PLACEHOLDER}
              placeholderTextColor={Colors.GRAY}
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
              {catalogBusy ? (
                <View style={styles.catalogLoadingRow}>
                  <ActivityIndicator size="small" color={Colors.GREEN} />
                  <Text style={styles.catalogLoadingText}>
                    {catalogTransitioning
                      ? `Loading ${networkLabel(effectiveNetwork)} bundles…`
                      : 'Updating reseller prices…'}
                  </Text>
                </View>
              ) : null}
              {displayedBundles.map((bundle) => {
                const isSelected = selectedBundle?.id === bundle.id;
                return (
                  <TouchableOpacity
                    key={bundle.id}
                    style={[
                      styles.bundleCard,
                      isSelected && styles.bundleCardSelected,
                    ]}
                    onPress={() => handleBundleSelect(bundle)}
                  >
                    <View style={styles.bundleInfo}>
                      <Text style={styles.bundleName}>{bundle.name}</Text>
                      <Text style={styles.bundleValidity}>{bundle.validity}</Text>
                    </View>
                    <Text
                      style={[
                        styles.bundleAmount,
                        isSelected && styles.bundleAmountSelected,
                      ]}
                    >
                      {formatNaira(bundle.amount)}
                    </Text>
                  </TouchableOpacity>
                );
              })}
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
              <Text style={styles.summaryAmount}>
                {formatNaira(selectedBundle.amount)}
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
              (!selectedBundle || buyState === 'processing') &&
                styles.primaryButtonDisabled,
            ]}
            onPress={handleBuy}
            disabled={!selectedBundle || buyState === 'processing'}
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
  recipientHeading: {
    ...Typography.SECTION_HEADING,
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
    borderColor: Colors.GREEN_MID,
    backgroundColor: Colors.GREEN_10,
    boxShadow: '0 2px 4px rgba(15, 61, 39, 0.10)',
  },
  contactActionIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: Colors.GREEN,
    alignItems: 'center',
    justifyContent: 'center',
  },
  contactActionTitle: {
    ...Typography.CARD_TITLE,
    fontSize: 13,
    lineHeight: 18,
    color: Colors.DARK,
  },
  contactActionDescription: {
    ...Typography.CAPTION,
    fontSize: 11,
    lineHeight: 16,
    color: Colors.GRAY,
  },
  contactActionButton: {
    minHeight: Spacing.TOUCH_TARGET_MIN,
    marginTop: 'auto',
    borderRadius: Spacing.TOUCH_TARGET_MIN / 2,
    backgroundColor: Colors.GREEN,
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
    borderColor: Colors.BORDER,
    borderRadius: Spacing.BUTTON_RADIUS,
    paddingHorizontal: Spacing.L,
    ...Typography.BODY,
    color: Colors.DARK,
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
    color: Colors.GREEN,
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
    borderColor: Colors.BORDER,
    backgroundColor: Colors.WHITE,
  },
  networkChipText: {
    ...Typography.BODY,
    fontSize: 13,
    color: Colors.DARK,
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
  catalogLoadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.S,
    marginBottom: Spacing.M,
  },
  catalogLoadingText: {
    color: Colors.GRAY,
    fontSize: 12,
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
  bundleValidity: {
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
  payHintRow: {
    marginBottom: Spacing.M,
    alignItems: 'center',
  },
  payHintText: {
    ...Typography.CAPTION,
    color: Colors.GRAY,
    textAlign: 'center',
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
