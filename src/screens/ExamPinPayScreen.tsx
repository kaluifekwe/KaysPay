import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import ProviderLogo from '../components/ProviderLogo';
import { useTransactionAuth } from '../components/TransactionAuthProvider';
import { Colors } from '../constants/colors';
import { Spacing } from '../constants/spacing';
import { Typography } from '../constants/typography';
import type { ExamType } from '../services/vtu.service';
import { formatNaira } from '../utils/formatCurrency';
import { EXAM_LOGOS } from '../utils/providerLogos';

const EXAM_BODY_LABELS: Record<string, string> = {
  waec: 'WAEC',
  neco: 'NECO',
  nabteb: 'NABTEB',
  jamb: 'JAMB',
  nbais: 'NBAIS',
};

function examBody(examId: string): string {
  if (examId === 'waec-registration') return 'waec';
  return examId.split('-')[0];
}

export default function ExamPinPayScreen({ navigation, route }: any) {
  const exam = route.params.exam as ExamType;
  const { authorize } = useTransactionAuth();
  const insets = useSafeAreaInsets();
  const scrollRef = useRef<ScrollView>(null);
  const [quantity, setQuantity] = useState(exam.quantity_options[0] || 1);
  const [profileCode, setProfileCode] = useState('');

  const totalAmount = exam.amount * quantity;
  const needsProfileCode = !!exam.requiresProfileCode;
  const hasProfileCode = !needsProfileCode || profileCode.trim().length > 0;
  const canProceed = exam.quantity_options.includes(quantity) && hasProfileCode;

  const payHint = useMemo(() => {
    if (needsProfileCode && !profileCode.trim()) return 'Enter your JAMB profile code';
    return null;
  }, [needsProfileCode, profileCode]);

  const handleProfileCodeChange = useCallback((text: string) => {
    setProfileCode(text.replace(/[^a-zA-Z0-9]/g, '').slice(0, 20).toUpperCase());
  }, []);

  const handlePay = useCallback(async () => {
    if (!canProceed) return;
    const authResult = await authorize({
      title: 'Confirm Exam PIN Purchase',
      amount: totalAmount,
      subtitle: `${exam.name} • Quantity ${quantity}`,
    });
    if (!authResult) return;

    navigation.navigate('TransactionStatus', {
      title: 'Exam PIN',
      amount: totalAmount,
      recipient: exam.name,
      paymentMethod: 'Balance',
      request: {
        kind: 'exam',
        examType: exam,
        quantity,
        profileCode: needsProfileCode ? profileCode.trim() : undefined,
        authToken: authResult.token,
      },
    });
  }, [authorize, canProceed, exam, navigation, needsProfileCode, profileCode, quantity, totalAmount]);

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <ScrollView
          ref={scrollRef}
          style={styles.flex}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <TouchableOpacity style={styles.backButton} activeOpacity={0.6} onPress={() => navigation.goBack()}>
            <Text style={styles.backText}>{'<'}</Text>
          </TouchableOpacity>

          <View style={styles.headingRow}>
            <ProviderLogo
              source={EXAM_LOGOS[examBody(exam.id)]}
              fallbackLabel={EXAM_BODY_LABELS[examBody(exam.id)] || exam.name}
              size={48}
            />
            <View style={styles.headingText}>
              <Text style={styles.title}>{exam.name}</Text>
              <Text style={styles.subtitle}>{formatNaira(exam.amount)} per PIN</Text>
            </View>
          </View>

          <View style={styles.section}>
            <Text style={styles.label}>Quantity</Text>
            <View style={styles.quantityContainer}>
              {exam.quantity_options.map((option) => {
                const selected = quantity === option;
                return (
                  <TouchableOpacity
                    key={option}
                    style={[styles.quantityButton, selected && styles.quantityButtonSelected]}
                    onPress={() => setQuantity(option)}
                    activeOpacity={0.7}
                  >
                    <Text style={[styles.quantityText, selected && styles.quantityTextSelected]}>{option}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>

          {needsProfileCode && (
            <View style={styles.section}>
              <Text style={styles.label}>JAMB Profile Code</Text>
              <TextInput
                style={styles.input}
                value={profileCode}
                onChangeText={handleProfileCodeChange}
                onFocus={() => scrollRef.current?.scrollToEnd({ animated: true })}
                placeholder="Enter your JAMB profile code"
                placeholderTextColor={Colors.GRAY}
                autoCapitalize="characters"
                autoCorrect={false}
              />
              <Text style={styles.inputHint}>Enter the profile code issued by JAMB and confirm it carefully before paying.</Text>
            </View>
          )}

          <View style={styles.summaryCard}>
            <View style={styles.summaryRow}>
              <Text style={styles.summaryLabel}>Exam PIN</Text>
              <Text style={styles.summaryValue}>{exam.name}</Text>
            </View>
            <View style={styles.divider} />
            <View style={styles.summaryRow}>
              <Text style={styles.summaryLabel}>Unit price</Text>
              <Text style={styles.summaryValue}>{formatNaira(exam.amount)}</Text>
            </View>
            <View style={styles.divider} />
            <View style={styles.summaryRow}>
              <Text style={styles.summaryLabel}>Quantity</Text>
              <Text style={styles.summaryValue}>{quantity}</Text>
            </View>
            <View style={styles.divider} />
            <View style={styles.summaryRow}>
              <Text style={styles.summaryLabel}>Total</Text>
              <Text style={styles.totalAmount}>{formatNaira(totalAmount)}</Text>
            </View>
          </View>
        </ScrollView>

        <View style={[styles.bottomBar, { paddingBottom: insets.bottom + Spacing.L }]}>
          {payHint ? <Text style={styles.payHint}>{payHint}</Text> : null}
          <TouchableOpacity
            style={[styles.payButton, !canProceed && styles.payButtonDisabled]}
            onPress={handlePay}
            disabled={!canProceed}
            activeOpacity={0.8}
          >
            <Text style={styles.payButtonText}>Pay {formatNaira(totalAmount)}</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.WHITE },
  flex: { flex: 1 },
  scrollContent: {
    paddingHorizontal: Spacing.SCREEN_PADDING,
    paddingTop: Spacing.M,
    paddingBottom: 170,
  },
  backButton: { width: 48, height: 48, justifyContent: 'center', alignItems: 'center', marginBottom: Spacing.M },
  backText: { fontSize: 28, fontWeight: '600', color: Colors.DARK },
  headingRow: { flexDirection: 'row', alignItems: 'center', marginBottom: Spacing.XL },
  headingText: { flex: 1, marginLeft: Spacing.M },
  title: { ...Typography.SCREEN_TITLE, fontSize: 22, marginBottom: 4 },
  subtitle: { ...Typography.BODY, color: Colors.GREEN },
  section: { marginBottom: Spacing.XL },
  label: { ...Typography.SECTION_HEADING, marginBottom: Spacing.M },
  quantityContainer: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.M },
  quantityButton: {
    width: 56,
    height: 56,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: Spacing.CARD_RADIUS,
    borderWidth: 1,
    borderColor: Colors.BORDER,
    backgroundColor: Colors.WHITE,
  },
  quantityButtonSelected: { backgroundColor: Colors.GREEN, borderColor: Colors.GREEN_DARK },
  quantityText: { ...Typography.CARD_TITLE, fontSize: 18 },
  quantityTextSelected: { color: Colors.WHITE },
  input: {
    height: Spacing.INPUT_HEIGHT,
    borderWidth: Spacing.INPUT_BORDER_WIDTH,
    borderColor: Colors.BORDER,
    borderRadius: Spacing.BUTTON_RADIUS,
    paddingHorizontal: Spacing.L,
    ...Typography.BODY,
    color: Colors.DARK,
  },
  inputHint: { ...Typography.CAPTION, color: Colors.GRAY, marginTop: Spacing.S },
  summaryCard: { padding: Spacing.CARD_PADDING, borderRadius: Spacing.CARD_RADIUS, backgroundColor: Colors.LIGHT_GRAY },
  summaryRow: { minHeight: 44, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  summaryLabel: { ...Typography.BODY, color: Colors.GRAY },
  summaryValue: { ...Typography.CARD_TITLE, flex: 1, textAlign: 'right', marginLeft: Spacing.M },
  totalAmount: { ...Typography.AMOUNT_SMALL, color: Colors.GREEN },
  divider: { height: 1, backgroundColor: Colors.BORDER },
  bottomBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: Spacing.SCREEN_PADDING,
    paddingTop: Spacing.L,
    borderTopWidth: 1,
    borderTopColor: Colors.BORDER,
    backgroundColor: Colors.WHITE,
  },
  payHint: { ...Typography.CAPTION, color: Colors.GRAY, textAlign: 'center', marginBottom: Spacing.M },
  payButton: { height: Spacing.BUTTON_HEIGHT_PRIMARY, borderRadius: Spacing.BUTTON_RADIUS, backgroundColor: Colors.GREEN, justifyContent: 'center', alignItems: 'center' },
  payButtonDisabled: { opacity: 0.5 },
  payButtonText: { ...Typography.BUTTON_TEXT },
});
