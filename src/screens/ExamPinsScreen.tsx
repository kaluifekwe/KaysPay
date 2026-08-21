import React, { useCallback, useState } from 'react';
import { ActivityIndicator, Keyboard, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { SafeAreaView } from 'react-native-safe-area-context';
import ProviderLogo from '../components/ProviderLogo';
import { AppTheme } from '../constants/theme';
import { useTheme } from '../components/ThemeProvider';
import { Spacing } from '../constants/spacing';
import { Typography } from '../constants/typography';
import { vtuService, type ExamType } from '../services/vtu.service';
import { formatNaira } from '../utils/formatCurrency';
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
  nbais: 'NBAIS',
};

function examBody(examId: string): string {
  if (examId === 'waec-registration') return 'waec';
  return examId.split('-')[0];
}

export default function ExamPinsScreen({ navigation }: ExamPinsScreenProps) {
  const { theme } = useTheme();
  const styles = createStyles(theme);
  const [examTypes, setExamTypes] = useState<ExamType[]>(() => vtuService.getExamTypes());
  const [refreshing, setRefreshing] = useState(false);

  useFocusEffect(useCallback(() => {
    let cancelled = false;
    setExamTypes(vtuService.getExamTypes());
    setRefreshing(true);
    vtuService.refreshExamTypes(true).then((fresh) => {
      if (!cancelled) setExamTypes(fresh);
    }).finally(() => {
      if (!cancelled) setRefreshing(false);
    });
    return () => { cancelled = true; };
  }, []));

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <TouchableOpacity style={styles.backButton} activeOpacity={0.6} onPress={() => { Keyboard.dismiss(); navigation.goBack(); }}>
          <Text style={styles.backText}>{'<'}</Text>
        </TouchableOpacity>

        <Text style={styles.title}>Buy Exam PIN</Text>
        <Text style={styles.subtitle}>Select the exam PIN you want to purchase</Text>

        {refreshing ? (
          <View style={styles.refreshRow}>
            <ActivityIndicator size="small" color={theme.brand} />
            <Text style={styles.refreshText}>Checking current prices…</Text>
          </View>
        ) : null}

        <View style={styles.examCards}>
          {examTypes.map((exam: ExamType) => (
            <TouchableOpacity
              key={exam.id}
              style={styles.examCard}
              onPress={() => navigation.navigate('ExamPinPay', { exam })}
              activeOpacity={0.7}
            >
              <ProviderLogo
                source={EXAM_LOGOS[examBody(exam.id)]}
                fallbackLabel={EXAM_BODY_LABELS[examBody(exam.id)] || exam.name}
                size={44}
                style={styles.examLogo}
              />
              <View style={styles.examDetails}>
                <Text style={styles.examName}>{exam.name}</Text>
                <Text style={styles.examPrice}>{formatNaira(exam.amount)} per PIN</Text>
              </View>
              <Text style={styles.chevron}>{'>'}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.background },
  scrollView: { flex: 1 },
  scrollContent: {
    paddingHorizontal: Spacing.SCREEN_PADDING,
    paddingTop: Spacing.M,
    paddingBottom: Spacing.XL,
  },
  backButton: { width: 48, height: 48, justifyContent: 'center', alignItems: 'center', marginBottom: Spacing.M },
  backText: { fontSize: 28, fontWeight: '600', color: theme.ink },
  title: { ...Typography.SCREEN_TITLE, color: theme.ink, marginBottom: Spacing.XS },
  subtitle: { ...Typography.BODY, color: theme.inkMuted, marginBottom: Spacing.L },
  refreshRow: { minHeight: 44, flexDirection: 'row', alignItems: 'center', marginBottom: Spacing.M },
  refreshText: { ...Typography.CAPTION, color: theme.inkMuted, marginLeft: Spacing.S },
  examCards: { gap: Spacing.M },
  examCard: {
    minHeight: 84,
    flexDirection: 'row',
    alignItems: 'center',
    padding: Spacing.CARD_PADDING,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: Spacing.CARD_RADIUS,
    backgroundColor: theme.surface,
  },
  examLogo: { marginRight: Spacing.M },
  examDetails: { flex: 1 },
  examName: { ...Typography.CARD_TITLE, color: theme.ink, marginBottom: 4 },
  examPrice: { ...Typography.CAPTION, color: theme.brand },
  chevron: { fontSize: 22, fontWeight: '600', color: theme.inkMuted, marginLeft: Spacing.S },
  });
}
