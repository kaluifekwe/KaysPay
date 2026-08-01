import React, { useState, useCallback, useMemo } from 'react';
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
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Colors } from '../constants/colors';
import { Typography } from '../constants/typography';
import { Spacing } from '../constants/spacing';
import { formatNaira } from '../utils/formatCurrency';
import { vtuService, type ExamType } from '../services/vtu.service';
import { useTransactionAuth } from '../components/TransactionAuthProvider';
import ProviderLogo from '../components/ProviderLogo';
import { EXAM_LOGOS } from '../utils/providerLogos';

interface ExamPinsScreenProps {
  navigation: {
    goBack: () => void;
    navigate: (screen: string, params?: Record<string, unknown>) => void;
  };
}

const EXAM_BODY_LABELS: Record<string, string> = {
  waec: 'WAEC',
  neco: 'NECO',
  nabteb: 'NABTEB',
  jamb: 'JAMB',
};

// Exam type ids are `${body}-${variant}` (e.g. "waec-gce") — the body prefix
// picks both the logo and the initials-fallback label.
function examBody(examId: string): string {
  return examId.split('-')[0];
}

export default function ExamPinsScreen({ navigation }: ExamPinsScreenProps) {
  const { authorize } = useTransactionAuth();
  const insets = useSafeAreaInsets();
  const [selectedExam, setSelectedExam] = useState<ExamType | null>(null);
  const [quantity, setQuantity] = useState<number>(1);
  const [isProcessing, setIsProcessing] = useState(false);
  const [resultPins, setResultPins] = useState<string[] | null>(null);
  const [resultExamName, setResultExamName] = useState<string>('');
  const [profileCode, setProfileCode] = useState('');

  const examTypes = useMemo(() => vtuService.getExamTypes(), []);

  const availableQuantities = useMemo(() => {
    if (!selectedExam) return [1, 2, 3, 4, 5];
    return selectedExam.quantity_options;
  }, [selectedExam]);

  const totalAmount = useMemo(() => {
    if (!selectedExam) return 0;
    return selectedExam.amount * quantity;
  }, [selectedExam, quantity]);

  const needsProfileCode = !!selectedExam?.requiresProfileCode;
  const canProceed =
    selectedExam &&
    quantity > 0 &&
    !isProcessing &&
    (!needsProfileCode || profileCode.trim().length > 0);

  // The single next thing the user must do before Pay can proceed — so the
  // greyed button is never a silent dead end. null once everything's ready.
  const payHint = useMemo(() => {
    if (isProcessing) return null;
    if (!selectedExam) return 'Select an exam type to continue';
    if (needsProfileCode && profileCode.trim().length === 0) return 'Enter your JAMB profile code';
    return null;
  }, [isProcessing, selectedExam, needsProfileCode, profileCode]);

  const handleExamSelect = useCallback((exam: ExamType) => {
    setSelectedExam(exam);
    setProfileCode('');
    if (!exam.quantity_options.includes(quantity)) {
      setQuantity(exam.quantity_options[0] || 1);
    }
  }, [quantity]);

  const handleQuantitySelect = useCallback((qty: number) => {
    setQuantity(qty);
  }, []);

  const handlePay = useCallback(async () => {
    if (!canProceed || !selectedExam) return;

    const authResult = await authorize({
      title: 'Confirm Exam PIN Purchase',
      amount: selectedExam.amount * quantity,
    });
    if (!authResult) return;

    // Go STRAIGHT to the result screen — it runs the purchase itself and shows
    // Processing -> Successful (with the exam PIN(s) displayed). No spinner on
    // the Pay button first.
    navigation.navigate('TransactionStatus', {
      title: 'Exam PIN',
      amount: selectedExam.amount * quantity,
      recipient: selectedExam.name,
      paymentMethod: 'Balance',
      request: {
        kind: 'exam',
        examType: selectedExam,
        quantity,
        profileCode: needsProfileCode ? profileCode.trim() : undefined,
        authToken: authResult.token,
      },
    });
  }, [canProceed, selectedExam, quantity, needsProfileCode, profileCode, navigation, authorize]);

  const handleNewPurchase = useCallback(() => {
    setResultPins(null);
    setResultExamName('');
    setSelectedExam(null);
    setQuantity(1);
    setProfileCode('');
  }, []);

  if (resultPins) {
    return (
      <SafeAreaView style={styles.container}>
        <KeyboardAvoidingView
          style={styles.keyboardView}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          <ScrollView
            style={styles.scrollView}
            contentContainerStyle={styles.scrollContent}
            showsVerticalScrollIndicator={false}
          >
            <TouchableOpacity
              style={styles.backButton}
              activeOpacity={0.6}
              onPress={handleNewPurchase}
            >
              <Text style={styles.backText}>{'<'}</Text>
            </TouchableOpacity>

            <View style={styles.successContainer}>
              <View style={styles.successIcon}>
                <Text style={styles.successIconText}>✓</Text>
              </View>
              <Text style={styles.successTitle}>Purchase Successful</Text>
              <Text style={styles.successSubtitle}>
                {resultExamName} - {resultPins.length} PIN{resultPins.length > 1 ? 's' : ''}
              </Text>
            </View>

            <View style={styles.pinsContainer}>
              <Text style={styles.pinsLabel}>Your PIN Codes</Text>
              {resultPins.map((pin, index) => (
                <View key={index} style={styles.pinCard}>
                  <Text style={styles.pinIndex}>PIN {index + 1}</Text>
                  <Text style={styles.pinCode}>{pin}</Text>
                </View>
              ))}
              <Text style={styles.copyHint}>
                Save these PINs securely.
              </Text>
            </View>

            <TouchableOpacity
              style={styles.newPurchaseButton}
              onPress={handleNewPurchase}
              activeOpacity={0.8}
            >
              <Text style={styles.newPurchaseButtonText}>Buy More PINs</Text>
            </TouchableOpacity>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    );
  }

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

          <Text style={styles.title}>Buy Exam PIN</Text>

          <View style={styles.section}>
            <Text style={styles.label}>Select Exam Type</Text>
            <View style={styles.examCardsContainer}>
              {examTypes.map((exam) => {
                const isSelected = selectedExam?.id === exam.id;
                return (
                  <TouchableOpacity
                    key={exam.id}
                    style={[
                      styles.examCard,
                      isSelected && styles.examCardSelected,
                    ]}
                    onPress={() => handleExamSelect(exam)}
                    disabled={isProcessing}
                    activeOpacity={0.7}
                  >
                    <View style={styles.examCardRow}>
                      <ProviderLogo
                        source={EXAM_LOGOS[examBody(exam.id)]}
                        fallbackLabel={EXAM_BODY_LABELS[examBody(exam.id)] || exam.name}
                        size={40}
                        style={styles.examCardLogo}
                      />
                      <View style={styles.examCardTextGroup}>
                        <Text
                          style={[
                            styles.examCardName,
                            isSelected && styles.examCardNameSelected,
                          ]}
                        >
                          {exam.name}
                        </Text>
                        <Text
                          style={[
                            styles.examCardPrice,
                            isSelected && styles.examCardPriceSelected,
                          ]}
                        >
                          {formatNaira(exam.amount)}
                        </Text>
                      </View>
                    </View>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>

          {selectedExam && (
            <View style={styles.section}>
              <Text style={styles.label}>Quantity</Text>
              <View style={styles.quantityContainer}>
                {availableQuantities.map((qty) => {
                  const isSelected = quantity === qty;
                  return (
                    <TouchableOpacity
                      key={qty}
                      style={[
                        styles.quantityButton,
                        isSelected && styles.quantityButtonSelected,
                      ]}
                      onPress={() => handleQuantitySelect(qty)}
                      disabled={isProcessing}
                      activeOpacity={0.7}
                    >
                      <Text
                        style={[
                          styles.quantityButtonText,
                          isSelected && styles.quantityButtonTextSelected,
                        ]}
                      >
                        {qty}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
          )}

          {needsProfileCode && (
            <View style={styles.section}>
              <Text style={styles.label}>JAMB Profile Code</Text>
              <TextInput
                style={styles.profileCodeInput}
                value={profileCode}
                onChangeText={setProfileCode}
                placeholder="Enter your JAMB profile code"
                placeholderTextColor={Colors.GRAY}
                autoCapitalize="characters"
                editable={!isProcessing}
              />
              <Text style={styles.profileCodeHint}>
                This is the profile code you already got from JAMB's own registration portal — not something we generate. Double-check it before paying.
              </Text>
            </View>
          )}

          {selectedExam && (
            <View style={styles.summaryContainer}>
              <View style={styles.summaryRow}>
                <Text style={styles.summaryLabel}>Exam Type</Text>
                <Text style={styles.summaryValue}>{selectedExam.name}</Text>
              </View>
              <View style={styles.summaryDivider} />
              <View style={styles.summaryRow}>
                <Text style={styles.summaryLabel}>Unit Price</Text>
                <Text style={styles.summaryValue}>{formatNaira(selectedExam.amount)}</Text>
              </View>
              <View style={styles.summaryDivider} />
              <View style={styles.summaryRow}>
                <Text style={styles.summaryLabel}>Quantity</Text>
                <Text style={styles.summaryValue}>{quantity}</Text>
              </View>
              <View style={styles.summaryDivider} />
              <View style={styles.summaryRow}>
                <Text style={styles.summaryLabel}>Total Amount</Text>
                <Text style={styles.summaryValueBold}>{formatNaira(totalAmount)}</Text>
              </View>
            </View>
          )}
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
                Pay{totalAmount > 0 ? ` ${formatNaira(totalAmount)}` : ''}
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
  examCardsContainer: {
    gap: Spacing.M,
  },
  examCard: {
    backgroundColor: Colors.LIGHT_GRAY,
    borderRadius: Spacing.CARD_RADIUS,
    padding: Spacing.CARD_PADDING,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  examCardSelected: {
    backgroundColor: Colors.GREEN_LIGHT,
    borderColor: Colors.GREEN,
  },
  examCardRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  examCardLogo: {
    marginRight: Spacing.M,
  },
  examCardTextGroup: {
    flex: 1,
  },
  examCardName: {
    ...Typography.CARD_TITLE,
    marginBottom: Spacing.S,
  },
  examCardNameSelected: {
    color: Colors.GREEN_DARK,
  },
  examCardPrice: {
    ...Typography.AMOUNT_SMALL,
  },
  examCardPriceSelected: {
    color: Colors.GREEN,
  },
  quantityContainer: {
    flexDirection: 'row',
    gap: Spacing.M,
  },
  profileCodeInput: {
    height: Spacing.INPUT_HEIGHT,
    borderWidth: Spacing.INPUT_BORDER_WIDTH,
    borderColor: Colors.BORDER,
    borderRadius: Spacing.BUTTON_RADIUS,
    paddingHorizontal: Spacing.L,
    ...Typography.BODY,
    color: Colors.DARK,
  },
  profileCodeHint: {
    ...Typography.CAPTION,
    color: Colors.GRAY,
    marginTop: Spacing.S,
  },
  quantityButton: {
    width: 56,
    height: 56,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: Spacing.CARD_RADIUS,
    backgroundColor: Colors.LIGHT_GRAY,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  quantityButtonSelected: {
    backgroundColor: Colors.GREEN,
    borderColor: Colors.GREEN_DARK,
  },
  quantityButtonText: {
    ...Typography.CARD_TITLE,
    fontSize: 18,
  },
  quantityButtonTextSelected: {
    color: Colors.WHITE,
  },
  summaryContainer: {
    backgroundColor: Colors.LIGHT_GRAY,
    borderRadius: Spacing.CARD_RADIUS,
    padding: Spacing.CARD_PADDING,
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
  summaryValueBold: {
    ...Typography.AMOUNT_SMALL,
    fontSize: 18,
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
    paddingHorizontal: Spacing.SCREEN_PADDING,
    paddingTop: Spacing.L,
    backgroundColor: Colors.WHITE,
    borderTopWidth: 1,
    borderTopColor: Colors.BORDER,
  },
  payHintRow: { marginBottom: Spacing.M, alignItems: 'center' },
  payHintText: { ...Typography.CAPTION, color: Colors.GRAY, textAlign: 'center' },
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
  successContainer: {
    alignItems: 'center',
    marginBottom: Spacing.XL,
    paddingTop: Spacing.L,
  },
  successIcon: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: Colors.GREEN_LIGHT,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: Spacing.L,
  },
  successIconText: {
    fontSize: 36,
    color: Colors.GREEN,
    fontWeight: '700',
  },
  successTitle: {
    ...Typography.SCREEN_TITLE,
    marginBottom: Spacing.S,
  },
  successSubtitle: {
    ...Typography.BODY,
    color: Colors.GRAY,
  },
  pinsContainer: {
    marginBottom: Spacing.XL,
  },
  pinsLabel: {
    ...Typography.SECTION_HEADING,
    marginBottom: Spacing.M,
  },
  pinCard: {
    backgroundColor: Colors.LIGHT_GRAY,
    borderRadius: Spacing.CARD_RADIUS,
    padding: Spacing.CARD_PADDING,
    marginBottom: Spacing.M,
    borderWidth: 1,
    borderColor: Colors.BORDER,
  },
  pinIndex: {
    ...Typography.CAPTION,
    marginBottom: Spacing.XS,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  pinCode: {
    ...Typography.CODE,
  },
  copyHint: {
    ...Typography.CAPTION,
    textAlign: 'center',
    marginTop: Spacing.M,
    color: Colors.GRAY,
  },
  newPurchaseButton: {
    backgroundColor: Colors.LIGHT_GRAY,
    borderRadius: Spacing.BUTTON_RADIUS,
    paddingVertical: Spacing.M + 4,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: Colors.BORDER,
  },
  newPurchaseButtonText: {
    ...Typography.BUTTON_TEXT,
    color: Colors.GREEN,
    fontSize: 15,
  },
});
