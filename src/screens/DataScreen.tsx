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
import { useFocusEffect } from '@react-navigation/native';
import { Colors } from '../constants/colors';
import { Typography } from '../constants/typography';
import { Spacing } from '../constants/spacing';
import { Strings } from '../constants/strings';
import {
  detectNetwork,
  validateNigerianPhone,
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

  useFocusEffect(useCallback(() => {
    let cancelled = false;
    if (!effectiveNetwork) {
      setBundles([]);
      setCatalogLoading(false);
      return () => { cancelled = true; };
    }

    setBundles(vtuService.getDataBundles(effectiveNetwork));
    setCatalogLoading(true);
    vtuService.refreshDataBundles(effectiveNetwork).then((fresh) => {
      if (cancelled) return;
      setBundles(fresh);
      setSelectedBundle((selected) => {
        if (!selected) return null;
        return fresh.find((bundle) => bundle.id === selected.id) ?? null;
      });
    }).finally(() => {
      if (!cancelled) setCatalogLoading(false);
    });
    return () => { cancelled = true; };
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
    setSelectedBundle((prev) => (prev?.id === bundle.id ? null : bundle));
  }, []);

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
      if (supported.length !== contacts.length) {
        Alert.alert('9mobile removed', '9mobile contacts were excluded from this purchase.');
      }
      if (supported.length === 0) return;
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

    if (!validateNigerianPhone(digits)) {
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
    if (!validateNigerianPhone(phoneNumber.replace(/\D/g, ''))) return "Enter the recipient's phone number";
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
            <View style={styles.labelRow}>
              <Text style={styles.label}>Phone Number</Text>
              <View style={styles.labelRowButtons}>
                <TouchableOpacity
                  style={styles.contactsBtn}
                  onPress={() => setPickerMode('single')}
                  activeOpacity={0.7}
                >
                  <Text style={styles.contactsBtnText}>📇 Contacts</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.contactsBtn}
                  onPress={() => setPickerMode('multi')}
                  activeOpacity={0.7}
                >
                  <Text style={styles.contactsBtnText}>👥 Bulk Send</Text>
                </TouchableOpacity>
              </View>
            </View>
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

          {bundles.length > 0 && (
            <View style={styles.section}>
              <Text style={styles.label}>Choose a Bundle</Text>
              {catalogLoading ? (
                <View style={styles.catalogLoadingRow}>
                  <ActivityIndicator size="small" color={Colors.GREEN} />
                  <Text style={styles.catalogLoadingText}>Updating reseller prices…</Text>
                </View>
              ) : null}
              {bundles.map((bundle) => {
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

          {effectiveNetwork && bundles.length === 0 && !catalogLoading && (
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
  labelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: Spacing.S,
  },
  labelRowButtons: {
    flexDirection: 'row',
    gap: Spacing.S,
  },
  contactsBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: Spacing.S,
    paddingHorizontal: Spacing.M,
    borderRadius: Spacing.BUTTON_RADIUS,
    backgroundColor: Colors.GREEN_LIGHT,
  },
  contactsBtnText: {
    ...Typography.CAPTION,
    color: Colors.GREEN,
    fontWeight: '600',
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
