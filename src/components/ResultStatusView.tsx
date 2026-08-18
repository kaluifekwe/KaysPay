import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { AppTheme } from '../constants/theme';
import { useTheme } from './ThemeProvider';
import { formatNaira } from '../utils/formatCurrency';

export type ResultStatus = 'processing' | 'success' | 'failed';

const SUCCESS_GREEN = '#22A45D';

// Presentational Processing -> Successful/Failed frame — the same look as the
// VTU TransactionStatusScreen, reused by services that keep their own success
// content (eSIM QR, NIN/BVN slip). No business logic: the parent drives
// `status` and passes service-specific content as children.
export default function ResultStatusView({
  status,
  headerTitle,
  amount,
  successLabel = 'Successful',
  processingLabel = 'Processing',
  failedLabel = 'Failed',
  processingHint = 'Confirming your order…',
  message,
  children,
  onDone,
  doneLabel = 'Done',
}: {
  status: ResultStatus;
  headerTitle?: string;
  amount?: number | null;
  successLabel?: string;
  processingLabel?: string;
  failedLabel?: string;
  processingHint?: string;
  message?: string;
  children?: React.ReactNode;
  onDone?: () => void;
  doneLabel?: string;
}) {
  const { theme } = useTheme();
  const styles = createStyles(theme);
  const visual =
    status === 'success'
      ? { color: SUCCESS_GREEN, icon: 'checkmark' as const, label: successLabel }
      : status === 'failed'
      ? { color: theme.down, icon: 'close' as const, label: failedLabel }
      : { color: theme.gold, icon: 'time' as const, label: processingLabel };

  return (
    <SafeAreaView style={styles.container}>
      {headerTitle ? (
        <View style={styles.header}>
          <Text style={styles.headerTitle}>{headerTitle}</Text>
        </View>
      ) : null}

      <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
        <View style={[styles.iconCircle, { backgroundColor: visual.color }]}>
          <Ionicons name={visual.icon} size={42} color="#FFFFFF" />
        </View>
        <Text style={styles.statusLabel}>{visual.label}</Text>
        {typeof amount === 'number' ? <Text style={styles.amount}>{formatNaira(amount)}</Text> : null}

        {status === 'processing' ? (
          <View style={styles.spinnerRow}>
            <ActivityIndicator size="small" color={theme.inkMuted} />
            <Text style={styles.processingHint}>{processingHint}</Text>
          </View>
        ) : null}

        {message ? <Text style={styles.message}>{message}</Text> : null}

        {children}
      </ScrollView>

      {status !== 'processing' && onDone ? (
        <TouchableOpacity style={styles.doneButton} onPress={onDone} activeOpacity={0.85}>
          <Text style={styles.doneText}>{doneLabel}</Text>
        </TouchableOpacity>
      ) : null}
    </SafeAreaView>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.background },
    header: { alignItems: 'center', paddingVertical: 14 },
    headerTitle: { fontSize: 18, fontWeight: '700', color: theme.ink },
    body: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24, paddingVertical: 20 },
    iconCircle: { width: 84, height: 84, borderRadius: 42, alignItems: 'center', justifyContent: 'center', marginBottom: 20 },
    statusLabel: { fontSize: 24, fontWeight: '700', color: theme.ink, marginBottom: 8 },
    amount: { fontSize: 36, fontWeight: '800', color: theme.ink, marginBottom: 12 },
    spinnerRow: { flexDirection: 'row', alignItems: 'center', marginTop: 6, marginBottom: 8 },
    processingHint: { marginLeft: 8, color: theme.inkMuted, fontSize: 14 },
    message: { marginTop: 12, fontSize: 14, color: theme.inkMuted, textAlign: 'center', lineHeight: 20 },
    doneButton: { margin: 20, backgroundColor: theme.brand, borderRadius: 14, paddingVertical: 16, alignItems: 'center' },
    doneText: { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },
  });
}
