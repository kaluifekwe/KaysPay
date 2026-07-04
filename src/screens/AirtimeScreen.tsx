import React, { useState, useCallback, useMemo, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  Alert,
  ActivityIndicator,
  StyleSheet,
  Keyboard,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Colors } from '../constants/colors';
import { Typography } from '../constants/typography';
import { Spacing } from '../constants/spacing';
import { Strings } from '../constants/strings';
import { detectNetwork, validateNigerianPhone, formatNigerianPhone } from '../utils/detectNetwork';
import { formatNaira } from '../utils/formatCurrency';
import { vtuService, type NetworkProvider } from '../services/vtu.service';
import { useTransactionAuth } from '../components/TransactionAuthProvider';
import ContactPickerModal from '../components/ContactPickerModal';
import ProviderLogo from '../components/ProviderLogo';
import { PickedContact } from '../services/contacts.service';
import { NETWORK_LOGOS } from '../utils/providerLogos';

interface AirtimeScreenProps {
  navigation: {
    goBack: () => void;
    navigate: (screen: string, params?: any) => void;
  };
}

const QUICK_AMOUNTS = [100, 200, 500, 1000, 2000, 5000];

const NETWORKS: { key: NetworkProvider; label: string }[] = [
  { key: 'mtn', label: 'MTN' },
  { key: 'airtel', label: 'Airtel' },
  { key: 'glo', label: 'Glo' },
  { key: '9mobile', label: '9mobile' },
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

function mapDetectedNetworkName(name: string): NetworkProvider | null {
  const lower = name.toLowerCase();
  if (lower === 'mtn' || lower === 'airtel' || lower === 'glo' || lower === '9mobile') {
    return lower as NetworkProvider;
  }
  return null;
}

export default function AirtimeScreen({ navigation }: AirtimeScreenProps) {
  const { authorize } = useTransactionAuth();
  const insets = useSafeAreaInsets();
  const [phoneNumber, setPhoneNumber] = useState('');
  const [selectedNetwork, setSelectedNetwork] = useState<NetworkProvider | null>(null);
  const [amount, setAmount] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [isManualNetwork, setIsManualNetwork] = useState(false);
  const [pickerMode, setPickerMode] = useState<'closed' | 'single' | 'multi'>('closed');

  const formattedPhone = useMemo(() => formatNigerianPhone(phoneNumber), [phoneNumber]);
  const isValidPhone = useMemo(() => validateNigerianPhone(phoneNumber), [phoneNumber]);
  const numericAmount = useMemo(() => parseInt(amount, 10), [amount]);
  const isValidAmount = !isNaN(numericAmount) && numericAmount > 0 && numericAmount <= 50000;

  const canProceed = isValidPhone && selectedNetwork && isValidAmount && !isProcessing;

  useEffect(() => {
    if (!isManualNetwork && phoneNumber.length >= 4) {
      const info = detectNetwork(phoneNumber);
      const detected = mapDetectedNetworkName(info.network);
      if (detected) {
        setSelectedNetwork(detected);
      }
    } else if (phoneNumber.length < 4) {
      if (!isManualNetwork) {
        setSelectedNetwork(null);
      }
    }
  }, [phoneNumber, isManualNetwork]);

  const handlePhoneChange = useCallback((text: string) => {
    const cleaned = text.replace(/[^0-9]/g, '').slice(0, 11);
    setPhoneNumber(cleaned);
    setIsManualNetwork(false);
  }, []);

  const handleNetworkSelect = useCallback((network: NetworkProvider) => {
    setSelectedNetwork((prev) => (prev === network ? null : network));
    setIsManualNetwork(true);
  }, []);

  const handleContactSelect = useCallback((c: PickedContact) => {
    setPhoneNumber(c.phone);
    setSelectedNetwork(c.network);
    setIsManualNetwork(true); // keep the contact's network; user can still override
    setPickerMode('closed');
  }, []);

  const handleBulkContactsSelected = useCallback(
    (contacts: PickedContact[]) => {
      setPickerMode('closed');
      if (contacts.length === 0) return;
      if (contacts.length === 1) {
        // Only one picked — fall back to the normal single-recipient form.
        handleContactSelect(contacts[0]);
        return;
      }
      navigation.navigate('BulkSendReview', { type: 'airtime', recipients: contacts });
    },
    [navigation, handleContactSelect],
  );

  const handleQuickAmount = useCallback((quickAmount: number) => {
    setAmount(quickAmount.toString());
    Keyboard.dismiss();
  }, []);

  const handleAmountChange = useCallback((text: string) => {
    const cleaned = text.replace(/[^0-9]/g, '').slice(0, 6);
    setAmount(cleaned);
  }, []);

  const handlePay = useCallback(async () => {
    if (!canProceed || !selectedNetwork) return;

    const authResult = await authorize({ title: 'Confirm Airtime Purchase', amount: numericAmount });
    if (!authResult) return;

    setIsProcessing(true);
    try {
      const result = await vtuService.buyAirtime(
        phoneNumber,
        selectedNetwork,
        numericAmount,
        authResult.token,
      );

      if (result.success) {
        Alert.alert(
          result.pending ? 'Order Processing' : Strings.SUCCESS_TRANSACTION,
          result.pending
            ? result.message || 'Your order is still processing. You will be notified once it completes.'
            : `${formatNaira(numericAmount)} airtime has been sent to ${formattedPhone}`,
          [{ text: 'OK', onPress: () => navigation.goBack() }],
        );
      } else {
        Alert.alert(
          'Purchase Failed',
          result.error || Strings.ERROR_GENERIC,
          [{ text: 'OK' }],
        );
      }
    } catch {
      Alert.alert(
        'Error',
        Strings.ERROR_GENERIC,
        [{ text: 'OK' }],
      );
    } finally {
      setIsProcessing(false);
    }
  }, [canProceed, selectedNetwork, formattedPhone, numericAmount, navigation, authorize]);

  const networkInfo = useMemo(() => {
    if (!selectedNetwork) return null;
    return detectNetwork(phoneNumber);
  }, [selectedNetwork, phoneNumber]);

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      <KeyboardAvoidingView
        style={styles.keyboardView}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
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

          <Text style={styles.title}>Buy Airtime</Text>

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
              maxLength={11}
              editable={!isProcessing}
            />
            {phoneNumber.length > 0 && (
              <View style={styles.phoneInfoRow}>
                <Text style={styles.phoneInfo}>{formattedPhone}</Text>
                {isValidPhone ? (
                  <Text style={styles.validIndicator}>Valid</Text>
                ) : (
                  <Text style={styles.invalidIndicator}>
                    {phoneNumber.length}/11 digits
                  </Text>
                )}
              </View>
            )}
          </View>

          <View style={styles.section}>
            <Text style={styles.label}>Network Provider</Text>
            {selectedNetwork && networkInfo && networkInfo.network !== 'Unknown' && (
              <View style={styles.detectedNetworkContainer}>
                <View style={[styles.detectedNetworkDot, { backgroundColor: networkInfo.color }]} />
                <Text style={styles.detectedNetworkText}>
                  Detected: {networkInfo.network}
                </Text>
              </View>
            )}
            <View style={styles.networkChipsContainer}>
              {NETWORKS.map(({ key, label }) => {
                const isSelected = selectedNetwork === key;
                return (
                  <TouchableOpacity
                    key={key}
                    style={[
                      styles.networkChip,
                      isSelected && { borderColor: NETWORK_COLORS[key] },
                    ]}
                    onPress={() => handleNetworkSelect(key)}
                    disabled={isProcessing}
                    activeOpacity={0.7}
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

          <View style={styles.section}>
            <Text style={styles.label}>Amount</Text>
            <View style={styles.quickAmountsContainer}>
              {QUICK_AMOUNTS.map((quickAmount) => {
                const isSelected = numericAmount === quickAmount;
                return (
                  <TouchableOpacity
                    key={quickAmount}
                    style={[
                      styles.quickAmountButton,
                      isSelected && styles.quickAmountButtonSelected,
                    ]}
                    onPress={() => handleQuickAmount(quickAmount)}
                    disabled={isProcessing}
                    activeOpacity={0.7}
                  >
                    <Text
                      style={[
                        styles.quickAmountText,
                        isSelected && styles.quickAmountTextSelected,
                      ]}
                    >
                      {formatNaira(quickAmount)}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            <View style={styles.customAmountContainer}>
              <Text style={styles.currencySymbol}>{formatNaira(0).charAt(0)}</Text>
              <TextInput
                style={styles.amountInput}
                placeholder="Enter amount"
                placeholderTextColor={Colors.GRAY}
                value={amount}
                onChangeText={handleAmountChange}
                keyboardType="numeric"
                maxLength={6}
                editable={!isProcessing}
              />
            </View>
            {numericAmount > 0 && !isValidAmount && (
              <Text style={styles.amountError}>
                {numericAmount > 50000 ? 'Maximum amount is ₦50,000' : 'Enter a valid amount'}
              </Text>
            )}
          </View>

          <View style={styles.summaryContainer}>
            <View style={styles.summaryRow}>
              <Text style={styles.summaryLabel}>Phone Number</Text>
              <Text style={styles.summaryValue}>{formattedPhone || '---'}</Text>
            </View>
            <View style={styles.summaryDivider} />
            <View style={styles.summaryRow}>
              <Text style={styles.summaryLabel}>Network</Text>
              <Text style={styles.summaryValue}>
                {selectedNetwork ? networkLabel(selectedNetwork) : '---'}
              </Text>
            </View>
            <View style={styles.summaryDivider} />
            <View style={styles.summaryRow}>
              <Text style={styles.summaryLabel}>Amount</Text>
              <Text style={styles.summaryValue}>
                {numericAmount > 0 ? formatNaira(numericAmount) : '---'}
              </Text>
            </View>
          </View>
        </ScrollView>

        <View style={[styles.bottomContainer, { paddingBottom: insets.bottom + Spacing.SCREEN_PADDING }]}>
          <TouchableOpacity
            style={[
              styles.payButton,
              !canProceed && styles.payButtonDisabled,
            ]}
            onPress={handlePay}
            disabled={!canProceed}
            activeOpacity={0.8}
          >
            {isProcessing ? (
              <ActivityIndicator color={Colors.WHITE} size="small" />
            ) : (
              <Text style={styles.payButtonText}>
                Pay {numericAmount > 0 ? formatNaira(numericAmount) : ''}
              </Text>
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
  keyboardView: {
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
  phoneInfoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: Spacing.S,
  },
  phoneInfo: {
    ...Typography.CAPTION,
    color: Colors.GRAY,
  },
  validIndicator: {
    ...Typography.CAPTION,
    color: Colors.GREEN,
    fontWeight: '600',
  },
  invalidIndicator: {
    ...Typography.CAPTION,
    color: Colors.GRAY,
  },
  detectedNetworkContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: Spacing.M,
    padding: Spacing.S,
    backgroundColor: Colors.LIGHT_GRAY,
    borderRadius: 8,
  },
  detectedNetworkDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    marginRight: Spacing.S,
  },
  detectedNetworkText: {
    ...Typography.CAPTION,
    color: Colors.GREEN,
    fontWeight: '500',
  },
  networkChipsContainer: {
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
  quickAmountsContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.M,
    marginBottom: Spacing.M,
  },
  quickAmountButton: {
    paddingHorizontal: Spacing.L,
    height: Spacing.CHIP_HEIGHT,
    borderRadius: Spacing.CHIP_HEIGHT / 2,
    borderWidth: 1,
    borderColor: Colors.BORDER,
    justifyContent: 'center',
    alignItems: 'center',
  },
  quickAmountButtonSelected: {
    borderColor: Colors.GREEN,
    backgroundColor: Colors.GREEN,
  },
  quickAmountText: {
    ...Typography.BODY,
    fontSize: 13,
    color: Colors.DARK,
  },
  quickAmountTextSelected: {
    color: Colors.WHITE,
    fontFamily: 'Helvetica-Bold',
  },
  customAmountContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    height: Spacing.INPUT_HEIGHT,
    borderWidth: Spacing.INPUT_BORDER_WIDTH,
    borderColor: Colors.BORDER,
    borderRadius: Spacing.BUTTON_RADIUS,
    paddingHorizontal: Spacing.L,
  },
  currencySymbol: {
    ...Typography.BODY,
    fontWeight: '600',
    color: Colors.DARK,
    marginRight: Spacing.S,
  },
  amountInput: {
    flex: 1,
    ...Typography.BODY,
    color: Colors.DARK,
  },
  amountError: {
    ...Typography.ERROR,
    marginTop: Spacing.S,
  },
  summaryContainer: {
    backgroundColor: Colors.LIGHT_GRAY,
    borderRadius: Spacing.CARD_RADIUS,
    padding: Spacing.CARD_PADDING,
    marginTop: Spacing.M,
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: Spacing.S,
  },
  summaryLabel: {
    ...Typography.BODY,
    color: Colors.GRAY,
  },
  summaryValue: {
    ...Typography.CARD_TITLE,
  },
  summaryDivider: {
    height: 1,
    backgroundColor: Colors.BORDER,
    marginVertical: Spacing.XS,
  },
  bottomContainer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    padding: Spacing.SCREEN_PADDING,
    backgroundColor: Colors.WHITE,
    borderTopWidth: 1,
    borderTopColor: Colors.BORDER,
  },
  payButton: {
    height: Spacing.BUTTON_HEIGHT_PRIMARY,
    backgroundColor: Colors.GREEN,
    borderRadius: Spacing.BUTTON_RADIUS,
    justifyContent: 'center',
    alignItems: 'center',
  },
  payButtonDisabled: {
    backgroundColor: Colors.GRAY,
    opacity: 0.6,
  },
  payButtonText: {
    ...Typography.BUTTON_TEXT,
  },
});
