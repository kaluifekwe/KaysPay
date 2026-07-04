import React, { useCallback, useEffect, useMemo, useState } from 'react';
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
import { Strings } from '../constants/strings';
import { formatNaira } from '../utils/formatCurrency';
import {
  vtuService,
  type DataBundle,
  type BatchResultItem,
} from '../services/vtu.service';
import { walletService } from '../services/wallet.service';
import { useTransactionAuth } from '../components/TransactionAuthProvider';
import { PickedContact } from '../services/contacts.service';
import { NETWORK_LABEL, NETWORK_COLOR } from '../utils/phone';
import { NETWORK_LOGOS } from '../utils/providerLogos';
import ProviderLogo from '../components/ProviderLogo';

type SendType = 'airtime' | 'data';
type Phase = 'review' | 'sending' | 'done';

interface BulkSendReviewScreenProps {
  navigation: any;
  route: any;
}

interface AirtimeRow {
  contact: PickedContact;
  amount: string;
}

interface DataRow {
  contact: PickedContact;
  bundle: DataBundle | null;
}

const QUICK_AMOUNTS = [100, 200, 500, 1000];

export default function BulkSendReviewScreen({ navigation, route }: BulkSendReviewScreenProps) {
  const { type, recipients }: { type: SendType; recipients: PickedContact[] } = route.params;
  const { authorize } = useTransactionAuth();
  const insets = useSafeAreaInsets();

  const [airtimeRows, setAirtimeRows] = useState<AirtimeRow[]>(
    recipients.map((contact) => ({ contact, amount: '' })),
  );
  const [dataRows, setDataRows] = useState<DataRow[]>(
    recipients.map((contact) => ({ contact, bundle: null })),
  );
  const [walletBalance, setWalletBalance] = useState<number | null>(null);
  const [phase, setPhase] = useState<Phase>('review');
  const [results, setResults] = useState<Record<string, BatchResultItem>>({});

  useEffect(() => {
    walletService.getWallet().then((res) => {
      if (res.success && res.wallet) setWalletBalance(res.wallet.available_balance);
    });
  }, []);

  const total = useMemo(() => {
    if (type === 'airtime') {
      return airtimeRows.reduce((sum, r) => sum + (parseInt(r.amount, 10) || 0), 0);
    }
    return dataRows.reduce((sum, r) => sum + (r.bundle?.amount ?? 0), 0);
  }, [type, airtimeRows, dataRows]);

  const canSend = useMemo(() => {
    if (type === 'airtime') {
      return airtimeRows.every((r) => {
        const n = parseInt(r.amount, 10);
        return !isNaN(n) && n > 0;
      });
    }
    return dataRows.every((r) => r.bundle !== null);
  }, [type, airtimeRows, dataRows]);

  const insufficientBalance = walletBalance !== null && total > walletBalance;

  const handleAirtimeAmountChange = useCallback((phone: string, text: string) => {
    const cleaned = text.replace(/[^0-9]/g, '').slice(0, 6);
    setAirtimeRows((prev) =>
      prev.map((r) => (r.contact.phone === phone ? { ...r, amount: cleaned } : r)),
    );
  }, []);

  const handleQuickAmount = useCallback((phone: string, amount: number) => {
    setAirtimeRows((prev) =>
      prev.map((r) => (r.contact.phone === phone ? { ...r, amount: String(amount) } : r)),
    );
  }, []);

  const handleBundleSelect = useCallback((phone: string, bundle: DataBundle) => {
    setDataRows((prev) =>
      prev.map((r) => (r.contact.phone === phone ? { ...r, bundle } : r)),
    );
  }, []);

  const handleSend = useCallback(async () => {
    if (!canSend) return;
    if (insufficientBalance) {
      Alert.alert(
        'Insufficient Balance',
        `This batch needs ${formatNaira(total)}, but your available balance is ${formatNaira(walletBalance ?? 0)}.`,
      );
      return;
    }

    const recipientCount = type === 'airtime' ? airtimeRows.length : dataRows.length;
    const authResult = await authorize({
      title: `Confirm Bulk ${type === 'airtime' ? 'Airtime' : 'Data'} Send`,
      amount: total,
      // One PIN entry authorizes the whole batch — a prompt per recipient
      // would be unusable. See TransactionAuthProvider's maxUses option.
      maxUses: recipientCount,
    });
    if (!authResult) return;

    setResults({});
    setPhase('sending');

    if (type === 'airtime') {
      await vtuService.buyAirtimeBatch(
        airtimeRows.map((r) => ({
          phone: r.contact.phone,
          network: r.contact.network,
          amount: parseInt(r.amount, 10),
        })),
        authResult.token,
        (_, result) => {
          setResults((prev) => ({ ...prev, [result.phone]: result }));
        },
      );
    } else {
      await vtuService.buyDataBatch(
        dataRows
          .filter((r): r is DataRow & { bundle: DataBundle } => r.bundle !== null)
          .map((r) => ({ phone: r.contact.phone, network: r.contact.network, bundle: r.bundle })),
        authResult.token,
        (_, result) => {
          setResults((prev) => ({ ...prev, [result.phone]: result }));
        },
      );
    }

    setPhase('done');
  }, [canSend, insufficientBalance, total, walletBalance, type, airtimeRows, dataRows, authorize]);

  const successCount = Object.values(results).filter((r) => r.success).length;
  const failedCount = Object.values(results).filter((r) => !r.success).length;

  const renderStatusIcon = (phone: string) => {
    const result = results[phone];
    if (phase === 'sending' && !result) {
      return <ActivityIndicator size="small" color={Colors.GRAY} />;
    }
    if (!result) return null;
    return (
      <Text style={result.success ? styles.statusSuccess : styles.statusFailed}>
        {result.success ? '✓' : '✗'}
      </Text>
    );
  };

  const locked = phase !== 'review';

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

          <Text style={styles.title}>
            Bulk {type === 'airtime' ? 'Airtime' : 'Data'}
          </Text>
          <Text style={styles.subtitle}>
            {recipients.length} recipient{recipients.length === 1 ? '' : 's'}
          </Text>

          {type === 'airtime'
            ? airtimeRows.map((row) => (
                <View key={row.contact.phone} style={styles.card}>
                  <View style={styles.cardHeader}>
                    <View style={styles.cardHeaderMid}>
                      <Text style={styles.name} numberOfLines={1}>
                        {row.contact.name}
                      </Text>
                      <View style={styles.numberRow}>
                        <Text style={styles.number}>{row.contact.phone}</Text>
                        <ProviderLogo
                          source={NETWORK_LOGOS[row.contact.network]}
                          fallbackLabel={NETWORK_LABEL[row.contact.network]}
                          fallbackColor={NETWORK_COLOR[row.contact.network]}
                          size={22}
                        />
                        <Text style={styles.networkLabel}>
                          {NETWORK_LABEL[row.contact.network]}
                        </Text>
                      </View>
                    </View>
                    {renderStatusIcon(row.contact.phone)}
                  </View>

                  <View style={styles.quickAmountsRow}>
                    {QUICK_AMOUNTS.map((qa) => (
                      <TouchableOpacity
                        key={qa}
                        style={[
                          styles.quickChip,
                          row.amount === String(qa) && styles.quickChipSelected,
                        ]}
                        onPress={() => handleQuickAmount(row.contact.phone, qa)}
                        disabled={locked}
                        activeOpacity={0.7}
                      >
                        <Text
                          style={[
                            styles.quickChipText,
                            row.amount === String(qa) && styles.quickChipTextSelected,
                          ]}
                        >
                          {formatNaira(qa)}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>

                  <TextInput
                    style={styles.amountInput}
                    placeholder="Enter amount"
                    placeholderTextColor={Colors.GRAY}
                    value={row.amount}
                    onChangeText={(text) => handleAirtimeAmountChange(row.contact.phone, text)}
                    keyboardType="numeric"
                    editable={!locked}
                  />
                </View>
              ))
            : dataRows.map((row) => {
                const bundles = vtuService.getDataBundles(row.contact.network);
                return (
                  <View key={row.contact.phone} style={styles.card}>
                    <View style={styles.cardHeader}>
                      <View style={styles.cardHeaderMid}>
                        <Text style={styles.name} numberOfLines={1}>
                          {row.contact.name}
                        </Text>
                        <View style={styles.numberRow}>
                          <Text style={styles.number}>{row.contact.phone}</Text>
                          <ProviderLogo
                            source={NETWORK_LOGOS[row.contact.network]}
                            fallbackLabel={NETWORK_LABEL[row.contact.network]}
                            fallbackColor={NETWORK_COLOR[row.contact.network]}
                            size={22}
                          />
                          <Text style={styles.networkLabel}>
                            {NETWORK_LABEL[row.contact.network]}
                          </Text>
                        </View>
                      </View>
                      {renderStatusIcon(row.contact.phone)}
                    </View>

                    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                      <View style={styles.bundleRow}>
                        {bundles.map((bundle) => {
                          const isSelected = row.bundle?.id === bundle.id;
                          return (
                            <TouchableOpacity
                              key={bundle.id}
                              style={[styles.bundleChip, isSelected && styles.bundleChipSelected]}
                              onPress={() => handleBundleSelect(row.contact.phone, bundle)}
                              disabled={locked}
                              activeOpacity={0.7}
                            >
                              <Text
                                style={[
                                  styles.bundleChipText,
                                  isSelected && styles.bundleChipTextSelected,
                                ]}
                              >
                                {bundle.name} · {formatNaira(bundle.amount)}
                              </Text>
                            </TouchableOpacity>
                          );
                        })}
                      </View>
                    </ScrollView>
                  </View>
                );
              })}

          {phase === 'done' && (
            <View style={styles.summaryContainer}>
              <Text style={styles.summaryText}>
                {successCount} sent{failedCount > 0 ? `, ${failedCount} failed` : ''}
              </Text>
            </View>
          )}
        </ScrollView>

        <View style={[styles.bottomContainer, { paddingBottom: insets.bottom + Spacing.SCREEN_PADDING }]}>
          {insufficientBalance && phase === 'review' && (
            <Text style={styles.insufficientText}>
              Insufficient balance for this total
            </Text>
          )}
          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>Total</Text>
            <Text style={styles.totalValue}>{formatNaira(total)}</Text>
          </View>
          {phase === 'done' ? (
            <TouchableOpacity
              style={styles.actionButton}
              onPress={() => navigation.goBack()}
              activeOpacity={0.8}
            >
              <Text style={styles.actionButtonText}>{Strings.BUTTON_DONE}</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={[
                styles.actionButton,
                (!canSend || phase === 'sending' || insufficientBalance) &&
                  styles.actionButtonDisabled,
              ]}
              onPress={handleSend}
              disabled={!canSend || phase === 'sending' || insufficientBalance}
              activeOpacity={0.8}
            >
              {phase === 'sending' ? (
                <ActivityIndicator color={Colors.WHITE} size="small" />
              ) : (
                <Text style={styles.actionButtonText}>
                  Send to {recipients.length} recipient{recipients.length === 1 ? '' : 's'}
                </Text>
              )}
            </TouchableOpacity>
          )}
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.WHITE },
  flex: { flex: 1 },
  scrollView: { flex: 1 },
  scrollContent: {
    paddingHorizontal: Spacing.SCREEN_PADDING,
    paddingTop: Spacing.M,
    paddingBottom: 160,
  },
  backButton: {
    width: 48,
    height: 48,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: Spacing.M,
  },
  backText: { fontSize: 28, fontWeight: '600', color: Colors.DARK },
  title: { ...Typography.SCREEN_TITLE },
  subtitle: {
    ...Typography.BODY,
    color: Colors.GRAY,
    marginBottom: Spacing.L,
  },
  card: {
    borderWidth: 1,
    borderColor: Colors.BORDER,
    borderRadius: Spacing.CARD_RADIUS,
    padding: Spacing.CARD_PADDING,
    marginBottom: Spacing.M,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: Spacing.M,
  },
  cardHeaderMid: { flex: 1, marginRight: Spacing.M },
  name: { ...Typography.CARD_TITLE },
  numberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 2,
  },
  number: { ...Typography.CAPTION, color: Colors.GRAY, marginRight: Spacing.S },
  networkLabel: {
    ...Typography.CAPTION,
    color: Colors.GRAY,
    marginLeft: Spacing.S,
  },
  statusSuccess: { color: Colors.GREEN, fontSize: 20, fontWeight: '700' },
  statusFailed: { color: Colors.RED, fontSize: 20, fontWeight: '700' },
  quickAmountsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.S,
    marginBottom: Spacing.S,
  },
  quickChip: {
    paddingHorizontal: Spacing.M,
    height: Spacing.CHIP_HEIGHT,
    borderRadius: Spacing.CHIP_HEIGHT / 2,
    borderWidth: 1,
    borderColor: Colors.BORDER,
    justifyContent: 'center',
    alignItems: 'center',
  },
  quickChipSelected: {
    borderColor: Colors.GREEN,
    backgroundColor: Colors.GREEN,
  },
  quickChipText: { ...Typography.CAPTION, color: Colors.DARK },
  quickChipTextSelected: { color: Colors.WHITE, fontWeight: '700' },
  amountInput: {
    height: Spacing.INPUT_HEIGHT,
    borderWidth: Spacing.INPUT_BORDER_WIDTH,
    borderColor: Colors.BORDER,
    borderRadius: Spacing.BUTTON_RADIUS,
    paddingHorizontal: Spacing.L,
    ...Typography.BODY,
    color: Colors.DARK,
  },
  bundleRow: { flexDirection: 'row', gap: Spacing.S },
  bundleChip: {
    paddingHorizontal: Spacing.M,
    height: Spacing.CHIP_HEIGHT,
    borderRadius: Spacing.CHIP_HEIGHT / 2,
    borderWidth: 1,
    borderColor: Colors.BORDER,
    justifyContent: 'center',
    alignItems: 'center',
  },
  bundleChipSelected: {
    borderColor: Colors.GREEN,
    backgroundColor: Colors.GREEN,
  },
  bundleChipText: { ...Typography.CAPTION, color: Colors.DARK },
  bundleChipTextSelected: { color: Colors.WHITE, fontWeight: '700' },
  summaryContainer: {
    backgroundColor: Colors.LIGHT_GRAY,
    borderRadius: Spacing.CARD_RADIUS,
    padding: Spacing.CARD_PADDING,
    marginTop: Spacing.M,
  },
  summaryText: { ...Typography.BODY, color: Colors.DARK, textAlign: 'center' },
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
  insufficientText: {
    ...Typography.ERROR,
    marginBottom: Spacing.S,
    textAlign: 'center',
  },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: Spacing.M,
  },
  totalLabel: { ...Typography.BODY, color: Colors.GRAY },
  totalValue: { ...Typography.AMOUNT_SMALL },
  actionButton: {
    height: Spacing.BUTTON_HEIGHT_PRIMARY,
    backgroundColor: Colors.GREEN,
    borderRadius: Spacing.BUTTON_RADIUS,
    justifyContent: 'center',
    alignItems: 'center',
  },
  actionButtonDisabled: {
    backgroundColor: Colors.GRAY,
    opacity: 0.6,
  },
  actionButtonText: { ...Typography.BUTTON_TEXT },
});
