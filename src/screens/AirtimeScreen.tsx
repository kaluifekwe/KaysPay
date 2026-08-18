import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
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
import { Ionicons } from '@expo/vector-icons';
import { Colors } from '../constants/colors';
import { AppTheme } from '../constants/theme';
import { useTheme } from '../components/ThemeProvider';
import { Typography } from '../constants/typography';
import { Spacing } from '../constants/spacing';
import { Strings } from '../constants/strings';
import { detectNetwork, isValidPhoneFormat, formatNigerianPhone } from '../utils/detectNetwork';
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
  if (lower === 'mtn' || lower === 'airtel' || lower === 'glo') {
    return lower as NetworkProvider;
  }
  return null;
}

export default function AirtimeScreen({ navigation }: AirtimeScreenProps) {
  const { authorize } = useTransactionAuth();
  const { theme } = useTheme();
  const styles = createStyles(theme);
  const insets = useSafeAreaInsets();
  const [phoneNumber, setPhoneNumber] = useState('');
  const [selectedNetwork, setSelectedNetwork] = useState<NetworkProvider | null>(null);
  const [amount, setAmount] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [isManualNetwork, setIsManualNetwork] = useState(false);
  const [pickerMode, setPickerMode] = useState<'closed' | 'single' | 'multi'>('closed');
  // The custom-amount field sits near the bottom of the form, right above
  // the fixed Pay bar — ScrollView never auto-scrolls a focused input into
  // view, so the keyboard can hide it entirely. Scroll to end on focus
  // brings it above the keyboard, same fix applied to Exam PIN/TV/Electricity.
  const scrollRef = useRef<ScrollView>(null);

  const formattedPhone = useMemo(() => formatNigerianPhone(phoneNumber), [phoneNumber]);
  const isValidPhone = useMemo(() => isValidPhoneFormat(phoneNumber), [phoneNumber]);
  const numericAmount = useMemo(() => parseInt(amount, 10), [amount]);
  const isValidAmount = !isNaN(numericAmount) && numericAmount >= 100 && numericAmount <= 50000;

  const canProceed = isValidPhone && selectedNetwork && isValidAmount && !isProcessing;

  // The single next thing the user must do before Pay can proceed — so the
  // greyed button is never a silent dead end. null once everything's ready.
  const payHint = useMemo(() => {
    if (isProcessing) return null;
    if (!isValidPhone) return "Enter the recipient's 11-digit phone number";
    if (!selectedNetwork) return 'Select a network to continue';
    if (numericAmount > 50000) return 'Maximum amount is ₦50,000';
    if (!isValidAmount) return 'Enter an amount of at least ₦100';
    return null;
  }, [isProcessing, isValidPhone, selectedNetwork, numericAmount, isValidAmount]);

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
    let digits = text.replace(/[^0-9]/g, '');
    // A pasted international format (+234 803… or 234 803…) normalizes to the
    // local 0-prefixed form, so copy-pasting a full number keeps all 11 digits
    // instead of losing the country code (or being cut mid-number).
    if (digits.startsWith('234')) digits = '0' + digits.slice(3);
    setPhoneNumber(digits.slice(0, 11));
    setIsManualNetwork(false);
  }, []);

  const handleNetworkSelect = useCallback((network: NetworkProvider) => {
    setSelectedNetwork((prev) => (prev === network ? null : network));
    setIsManualNetwork(true);
  }, []);

  const handleContactSelect = useCallback((c: PickedContact) => {
    if (c.network === '9mobile') {
      Alert.alert('Network unavailable', '9mobile purchases are currently unavailable.');
      return;
    }
    setPhoneNumber(c.phone);
    setSelectedNetwork(c.network);
    setIsManualNetwork(true); // keep the contact's network; user can still override
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
        // Only one picked — fall back to the normal single-recipient form.
        handleContactSelect(supported[0]);
        return;
      }
      navigation.navigate('BulkSendReview', { type: 'airtime', recipients: supported });
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

    // Go STRAIGHT to the result screen — it runs the purchase itself and shows
    // Processing -> Successful. No spinner on the Pay button first.
    navigation.navigate('TransactionStatus', {
      title: 'Airtime',
      amount: numericAmount,
      recipient: formattedPhone,
      paymentMethod: 'Balance',
      request: {
        kind: 'airtime',
        phone: phoneNumber,
        network: selectedNetwork,
        amount: numericAmount,
        authToken: authResult.token,
      },
    });
  }, [canProceed, selectedNetwork, formattedPhone, numericAmount, phoneNumber, navigation, authorize]);

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
          ref={scrollRef}
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
              placeholderTextColor={theme.inkMuted}
              keyboardType="phone-pad"
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
            {/* A prefix that isn't in the detection table (unlisted, or a
                ported number) leaves selectedNetwork null with nothing
                telling the user why — the bottom pay-hint alone was too easy
                to miss. This puts the actual instruction right next to the
                chips the user needs to tap. */}
            {isValidPhone && !selectedNetwork && (
              <View style={styles.undetectedNetworkContainer}>
                <Text style={styles.undetectedNetworkText}>
                  We couldn't detect this number's network automatically — please select it below.
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
                placeholderTextColor={theme.inkMuted}
                value={amount}
                onChangeText={handleAmountChange}
                onFocus={() => scrollRef.current?.scrollToEnd({ animated: true })}
                keyboardType="numeric"
                maxLength={6}
                editable={!isProcessing}
              />
            </View>
            {numericAmount > 0 && !isValidAmount && (
              <Text style={styles.amountError}>
                {numericAmount > 50000 ? 'Maximum amount is ₦50,000' : 'Minimum airtime is ₦100'}
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
          {payHint && (
            <View style={styles.payHintRow}>
              <Text style={styles.payHintText}>{payHint}</Text>
            </View>
          )}
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

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.background,
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
    // See ExamPinsScreen.tsx's identical comment — 120 only fit the Pay
    // button alone; the hint line above it could push it taller than that,
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
  phoneInfoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: Spacing.S,
  },
  phoneInfo: {
    ...Typography.CAPTION,
    color: theme.inkMuted,
  },
  validIndicator: {
    ...Typography.CAPTION,
    color: theme.brand,
    fontWeight: '600',
  },
  invalidIndicator: {
    ...Typography.CAPTION,
    color: theme.inkMuted,
  },
  detectedNetworkContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: Spacing.M,
    padding: Spacing.S,
    backgroundColor: theme.surfaceRaised,
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
    color: theme.brand,
    fontWeight: '500',
  },
  undetectedNetworkContainer: {
    marginBottom: Spacing.M,
    padding: Spacing.S,
    backgroundColor: '#FEF3C7',
    borderRadius: 8,
  },
  undetectedNetworkText: {
    ...Typography.CAPTION,
    color: '#92400E',
    fontWeight: '600',
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
    borderColor: theme.border,
    backgroundColor: theme.surface,
  },
  networkChipText: {
    ...Typography.BODY,
    fontSize: 13,
    color: theme.ink,
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
    borderColor: theme.border,
    justifyContent: 'center',
    alignItems: 'center',
  },
  quickAmountButtonSelected: {
    borderColor: theme.brand,
    backgroundColor: theme.brand,
  },
  quickAmountText: {
    ...Typography.BODY,
    fontSize: 13,
    color: theme.ink,
  },
  quickAmountTextSelected: {
    color: '#FFFFFF',
    fontFamily: 'Helvetica-Bold',
  },
  customAmountContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    height: Spacing.INPUT_HEIGHT,
    borderWidth: Spacing.INPUT_BORDER_WIDTH,
    borderColor: theme.border,
    borderRadius: Spacing.BUTTON_RADIUS,
    paddingHorizontal: Spacing.L,
  },
  currencySymbol: {
    ...Typography.BODY,
    fontWeight: '600',
    color: theme.ink,
    marginRight: Spacing.S,
  },
  amountInput: {
    flex: 1,
    ...Typography.BODY,
    color: theme.ink,
  },
  amountError: {
    ...Typography.ERROR,
    marginTop: Spacing.S,
  },
  summaryContainer: {
    backgroundColor: theme.surfaceRaised,
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
    color: theme.inkMuted,
  },
  summaryValue: {
    ...Typography.CARD_TITLE,
    color: theme.ink,
  },
  summaryDivider: {
    height: 1,
    backgroundColor: theme.border,
    marginVertical: Spacing.XS,
  },
  bottomContainer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    padding: Spacing.SCREEN_PADDING,
    backgroundColor: theme.surface,
    borderTopWidth: 1,
    borderTopColor: theme.border,
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
  payButton: {
    height: Spacing.BUTTON_HEIGHT_PRIMARY,
    backgroundColor: theme.brand,
    borderRadius: Spacing.BUTTON_RADIUS,
    justifyContent: 'center',
    alignItems: 'center',
  },
  payButtonDisabled: {
    backgroundColor: theme.inkFaint,
    opacity: 0.6,
  },
  payButtonText: {
    ...Typography.BUTTON_TEXT,
  },
  });
}
