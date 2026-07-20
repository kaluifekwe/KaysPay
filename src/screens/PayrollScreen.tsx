import React, { useState, useCallback, useMemo, useEffect } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  TextInput,
  Alert,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Modal,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Colors } from '../constants/colors';
import { Typography } from '../constants/typography';
import { Spacing } from '../constants/spacing';
import { formatNaira } from '../utils/formatCurrency';
import { formatNigerianPhone } from '../utils/detectNetwork';
import { NETWORK_LABEL, NETWORK_COLOR } from '../utils/phone';
import { NETWORK_LOGOS } from '../utils/providerLogos';
import ProviderLogo from '../components/ProviderLogo';
import ContactPickerModal from '../components/ContactPickerModal';
import DateTimePickerModal from '../components/DateTimePickerModal';
import { PickedContact } from '../services/contacts.service';
import { vtuService, type NetworkProvider, type DataBundle, type BatchResultItem } from '../services/vtu.service';
import { payrollService, type PayrollFrequency, type ScheduledPayroll } from '../services/payroll.service';
import { useTransactionAuth } from '../components/TransactionAuthProvider';

type ServiceType = 'airtime' | 'data';
type ScheduleType = 'now' | 'schedule';

interface Recipient {
  id: string;
  phone: string;
  network: NetworkProvider;
  name?: string;
  amount: string;            // airtime, naira
  bundle: DataBundle | null; // data
}

const NETWORKS: NetworkProvider[] = ['mtn', 'airtel', 'glo', '9mobile'];
const genId = () => Math.random().toString(36).slice(2, 10);

export default function PayrollScreen({ navigation }: any) {
  const { authorize } = useTransactionAuth();
  const insets = useSafeAreaInsets();

  const [serviceType, setServiceType] = useState<ServiceType>('airtime');
  const [scheduleType, setScheduleType] = useState<ScheduleType>('now');
  const [frequency, setFrequency] = useState<PayrollFrequency>('once');
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [bundleFor, setBundleFor] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);

  const [scheduledDate, setScheduledDate] = useState<Date | null>(null);
  const [datePickerOpen, setDatePickerOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const [manageOpen, setManageOpen] = useState(false);
  const [active, setActive] = useState<ScheduledPayroll[]>([]);
  const [loadingActive, setLoadingActive] = useState(false);

  const refreshActive = useCallback(async () => {
    setLoadingActive(true);
    setActive(await payrollService.getActive());
    setLoadingActive(false);
  }, []);

  useEffect(() => { refreshActive(); }, [refreshActive]);

  const total = useMemo(
    () =>
      recipients.reduce((sum, r) => {
        if (serviceType === 'airtime') return sum + (parseInt(r.amount, 10) || 0);
        return sum + (r.bundle ? r.bundle.amount / 100 : 0);
      }, 0),
    [recipients, serviceType],
  );

  const allValid = useMemo(
    () =>
      recipients.length > 0 &&
      recipients.every((r) => {
        if (!/^0\d{10}$/.test(r.phone)) return false;
        if (serviceType === 'airtime') {
          const n = parseInt(r.amount, 10);
          return !isNaN(n) && n >= 50 && n <= 50000;
        }
        return r.bundle !== null && r.bundle.network === r.network;
      }),
    [recipients, serviceType],
  );

  const addFromContacts = useCallback((contacts: PickedContact[]) => {
    setPickerOpen(false);
    setRecipients((prev) => {
      const existing = new Set(prev.map((r) => r.phone));
      const additions = contacts
        .filter((c) => !existing.has(c.phone))
        .map((c) => ({
          id: genId(),
          phone: c.phone,
          network: c.network as NetworkProvider,
          name: c.name,
          amount: '',
          bundle: null,
        }));
      return [...prev, ...additions];
    });
  }, []);

  const addManual = useCallback(() => {
    setRecipients((prev) => [...prev, { id: genId(), phone: '', network: 'mtn', amount: '', bundle: null }]);
  }, []);

  const updateRecipient = useCallback((id: string, patch: Partial<Recipient>) => {
    setRecipients((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }, []);

  const removeRecipient = useCallback((id: string) => {
    setRecipients((prev) => prev.filter((r) => r.id !== id));
  }, []);

  const resetForm = useCallback(() => {
    setRecipients([]);
    setScheduledDate(null);
    setFrequency('once');
    setEditingId(null);
  }, []);

  // Load an existing payroll into the form for editing (add/remove recipients).
  const startEdit = useCallback((p: ScheduledPayroll) => {
    setManageOpen(false);
    setEditingId(p.id);
    setServiceType(p.service_type);
    setScheduleType('schedule');
    setFrequency(p.frequency);
    setRecipients(
      (p.recipients || []).map((r: any) => {
        const network = String(r.network) as NetworkProvider;
        const bundle =
          p.service_type === 'data'
            ? vtuService.getDataBundles(network).find((b) => b.id === r.bundle_id) ?? null
            : null;
        return {
          id: genId(),
          phone: String(r.phone),
          network,
          amount: p.service_type === 'airtime' ? String(Math.round((r.amount_kobo || 0) / 100)) : '',
          bundle,
        };
      }),
    );
  }, []);

  const handleSaveEdit = useCallback(async () => {
    if (!editingId) return;
    const authResult = await authorize({ title: 'Confirm Payroll Changes', amount: total });
    if (!authResult) return;
    setProcessing(true);
    try {
      const res = await payrollService.update(
        editingId,
        recipients.map((r) =>
          serviceType === 'airtime'
            ? { phone: r.phone, network: r.network, amount_kobo: parseInt(r.amount, 10) * 100 }
            : { phone: r.phone, network: r.network, bundle_id: r.bundle!.id },
        ),
        authResult.token,
      );
      if (res.success) {
        Alert.alert('Payroll Updated ✓', 'Your changes have been saved.', [
          { text: 'Done', onPress: () => { resetForm(); refreshActive(); } },
        ]);
      } else {
        Alert.alert('Could not update', res.error || 'Please try again.');
      }
    } finally {
      setProcessing(false);
    }
  }, [editingId, authorize, total, recipients, serviceType, resetForm, refreshActive]);

  const handleSendNow = useCallback(async () => {
    const authResult = await authorize({ title: 'Confirm Payroll', amount: total, maxUses: recipients.length });
    if (!authResult) return;

    setProcessing(true);
    try {
      let results: BatchResultItem[];
      if (serviceType === 'airtime') {
        results = await vtuService.buyAirtimeBatch(
          recipients.map((r) => ({ phone: r.phone, network: r.network, amount: parseInt(r.amount, 10) })),
          authResult.token,
        );
      } else {
        results = await vtuService.buyDataBatch(
          recipients.map((r) => ({ phone: r.phone, network: r.network, bundle: r.bundle! })),
          authResult.token,
        );
      }
      const ok = results.filter((r) => r.success).length;
      const failed = results.length - ok;
      Alert.alert(
        'Payroll Sent',
        `${ok} of ${results.length} sent${failed > 0 ? `. ${failed} failed and were refunded.` : '.'}`,
        [{ text: 'OK', onPress: resetForm }],
      );
    } catch {
      Alert.alert('Error', 'Something went wrong. Please check Transaction History.');
    } finally {
      setProcessing(false);
    }
  }, [authorize, recipients, total, serviceType, resetForm]);

  const handleSchedule = useCallback(async () => {
    if (!scheduledDate || scheduledDate.getTime() <= Date.now()) {
      Alert.alert('Invalid date', 'Enter a valid future date and time (YYYY-MM-DD and HH:MM).');
      return;
    }

    const freqLabel = frequency === 'once' ? 'once' : frequency === 'weekly' ? 'every week' : 'every month';
    const authResult = await authorize({ title: 'Confirm & Schedule Payroll', amount: total });
    if (!authResult) return;

    setProcessing(true);
    try {
      const result = await payrollService.schedule(
        serviceType,
        recipients.map((r) =>
          serviceType === 'airtime'
            ? { phone: r.phone, network: r.network, amount_kobo: parseInt(r.amount, 10) * 100 }
            : { phone: r.phone, network: r.network, bundle_id: r.bundle!.id },
        ),
        scheduledDate.toISOString(),
        frequency,
        authResult.token,
      );
      if (result.success) {
        Alert.alert(
          'Payroll Scheduled ✓',
          `${formatNaira(total)} to ${recipients.length} recipient(s), ${freqLabel}, starting ${scheduledDate.toLocaleString()}.` +
            (frequency === 'once'
              ? ' Your wallet is charged on that date.'
              : ' Your wallet is charged automatically on each run — keep enough balance. It runs until you cancel.'),
          [{ text: 'Done', onPress: () => { resetForm(); refreshActive(); } }],
        );
      } else {
        Alert.alert('Could not schedule', result.error || 'Please try again.');
      }
    } finally {
      setProcessing(false);
    }
  }, [authorize, recipients, total, serviceType, scheduledDate, frequency, resetForm, refreshActive]);

  const handleCancelPayroll = useCallback((p: ScheduledPayroll) => {
    Alert.alert(
      'Cancel Payroll?',
      `Stop this ${p.frequency} payroll of ${formatNaira(p.total_amount / 100)} to ${p.recipients.length} recipient(s)? No more runs will happen.`,
      [
        { text: 'Keep it', style: 'cancel' },
        {
          text: 'Cancel Payroll',
          style: 'destructive',
          onPress: async () => {
            const res = await payrollService.cancel(p.id);
            if (res.success) refreshActive();
            else Alert.alert('Error', res.error || 'Could not cancel.');
          },
        },
      ],
    );
  }, [refreshActive]);

  const canSubmit =
    allValid && !processing && (editingId ? true : scheduleType === 'now' || scheduledDate !== null);
  const freqLabelShort = (f: PayrollFrequency) => (f === 'once' ? 'One-time' : f === 'weekly' ? 'Weekly' : 'Monthly');

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          style={styles.scrollView}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.headerRow}>
            <TouchableOpacity style={styles.backButton} onPress={() => navigation.goBack()}>
              <Text style={styles.backText}>{'<'}</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => { setManageOpen(true); refreshActive(); }}>
              <Text style={styles.manageLink}>Scheduled{active.length > 0 ? ` (${active.length})` : ''}</Text>
            </TouchableOpacity>
          </View>

          <Text style={styles.title}>{editingId ? 'Edit Payroll' : 'Payroll'}</Text>
          <Text style={styles.subtitle}>
            {editingId
              ? `Add or remove recipients (${serviceType}). Saving re-confirms with your PIN.`
              : 'Send airtime or data to many people — now, or on a recurring schedule.'}
          </Text>

          {editingId && (
            <TouchableOpacity style={styles.cancelEditBtn} onPress={resetForm}>
              <Text style={styles.cancelEditText}>✕ Cancel editing</Text>
            </TouchableOpacity>
          )}

          {/* Service type (fixed while editing an existing payroll) */}
          {!editingId && (
            <View style={styles.toggle}>
              {(['airtime', 'data'] as ServiceType[]).map((s) => (
                <TouchableOpacity
                  key={s}
                  style={[styles.toggleBtn, serviceType === s && styles.toggleBtnActive]}
                  onPress={() => { setServiceType(s); setRecipients((prev) => prev.map((r) => ({ ...r, bundle: null, amount: '' }))); }}
                >
                  <Text style={[styles.toggleText, serviceType === s && styles.toggleTextActive]}>
                    {s === 'airtime' ? 'Airtime' : 'Data'}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          )}

          <View style={styles.addRow}>
            <TouchableOpacity style={styles.addBtn} onPress={() => setPickerOpen(true)}>
              <Text style={styles.addBtnText}>📇 Add from Contacts</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.addBtnOutline} onPress={addManual}>
              <Text style={styles.addBtnOutlineText}>+ Manual</Text>
            </TouchableOpacity>
          </View>

          {recipients.length === 0 ? (
            <View style={styles.emptyBox}>
              <Text style={styles.emptyText}>No recipients yet. Add from contacts or enter numbers manually.</Text>
            </View>
          ) : (
            recipients.map((r) => (
              <View key={r.id} style={styles.recipientCard}>
                <View style={styles.recipientTop}>
                  <ProviderLogo
                    source={NETWORK_LOGOS[r.network]}
                    fallbackLabel={NETWORK_LABEL[r.network]}
                    fallbackColor={NETWORK_COLOR[r.network]}
                    size={32}
                  />
                  <View style={styles.recipientInfo}>
                    {r.name ? <Text style={styles.recipientName} numberOfLines={1}>{r.name}</Text> : null}
                    <TextInput
                      style={styles.phoneInput}
                      value={r.name ? formatNigerianPhone(r.phone) : r.phone}
                      onChangeText={(t) => updateRecipient(r.id, { phone: t.replace(/[^0-9]/g, '').slice(0, 11), name: undefined })}
                      placeholder="0803 000 0000"
                      placeholderTextColor={Colors.GRAY}
                      keyboardType="number-pad"
                      editable={!r.name}
                    />
                  </View>
                  <TouchableOpacity onPress={() => removeRecipient(r.id)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                    <Text style={styles.removeX}>✕</Text>
                  </TouchableOpacity>
                </View>

                <View style={styles.networkRow}>
                  {NETWORKS.map((n) => (
                    <TouchableOpacity
                      key={n}
                      style={[styles.netChip, r.network === n && styles.netChipActive]}
                      onPress={() => updateRecipient(r.id, { network: n, bundle: null })}
                    >
                      <Text style={[styles.netChipText, r.network === n && styles.netChipTextActive]}>{NETWORK_LABEL[n]}</Text>
                    </TouchableOpacity>
                  ))}
                </View>

                {serviceType === 'airtime' ? (
                  <View style={styles.amountRow}>
                    <Text style={styles.currency}>₦</Text>
                    <TextInput
                      style={styles.amountInput}
                      value={r.amount}
                      onChangeText={(t) => updateRecipient(r.id, { amount: t.replace(/[^0-9]/g, '').slice(0, 5) })}
                      placeholder="Amount"
                      placeholderTextColor={Colors.GRAY}
                      keyboardType="number-pad"
                    />
                  </View>
                ) : (
                  <TouchableOpacity style={styles.bundleBtn} onPress={() => setBundleFor(r.id)}>
                    <Text style={[styles.bundleBtnText, !r.bundle && styles.bundleBtnPlaceholder]}>
                      {r.bundle ? `${r.bundle.name} · ${formatNaira(r.bundle.amount / 100)}` : 'Select data plan'}
                    </Text>
                    <Text style={styles.bundleArrow}>{'>'}</Text>
                  </TouchableOpacity>
                )}
              </View>
            ))
          )}

          {/* When (not shown while editing recipients of an existing payroll) */}
          {!editingId && (
          <View style={styles.section}>
            <Text style={styles.label}>When</Text>
            <View style={styles.toggle}>
              {(['now', 'schedule'] as ScheduleType[]).map((s) => (
                <TouchableOpacity
                  key={s}
                  style={[styles.toggleBtn, scheduleType === s && styles.toggleBtnActive]}
                  onPress={() => setScheduleType(s)}
                >
                  <Text style={[styles.toggleText, scheduleType === s && styles.toggleTextActive]}>
                    {s === 'now' ? 'Send Now' : 'Schedule'}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            {scheduleType === 'schedule' && (
              <View style={styles.scheduleInputs}>
                <Text style={styles.fieldLabel}>Repeat</Text>
                <View style={styles.freqRow}>
                  {(['once', 'weekly', 'monthly'] as PayrollFrequency[]).map((f) => (
                    <TouchableOpacity
                      key={f}
                      style={[styles.freqChip, frequency === f && styles.freqChipActive]}
                      onPress={() => setFrequency(f)}
                    >
                      <Text style={[styles.freqChipText, frequency === f && styles.freqChipTextActive]}>{freqLabelShort(f)}</Text>
                    </TouchableOpacity>
                  ))}
                </View>

                <Text style={styles.fieldLabel}>{frequency === 'once' ? 'Date & time' : 'First run date & time'}</Text>
                <TouchableOpacity style={styles.dateBtn} onPress={() => setDatePickerOpen(true)}>
                  <Text style={[styles.dateBtnText, !scheduledDate && styles.dateBtnPlaceholder]}>
                    {scheduledDate
                      ? scheduledDate.toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' })
                      : '📅 Tap to pick a date & time'}
                  </Text>
                </TouchableOpacity>
                <Text style={styles.debitNote}>
                  {frequency === 'once'
                    ? 'Your wallet is charged on the date above.'
                    : `Your wallet is charged automatically ${frequency === 'weekly' ? 'each week' : 'each month'} — keep enough balance. Runs until you cancel it.`}
                </Text>
              </View>
            )}
          </View>
          )}
        </ScrollView>

        <View style={[styles.bottomBar, { paddingBottom: insets.bottom + Spacing.L }]}>
          {recipients.length > 0 && (
            <View style={styles.summary}>
              <Text style={styles.summaryLabel}>{recipients.length} recipient{recipients.length > 1 ? 's' : ''}</Text>
              <Text style={styles.summaryTotal}>{formatNaira(total)}{!editingId && scheduleType === 'schedule' && frequency !== 'once' ? ` / ${frequency === 'weekly' ? 'wk' : 'mo'}` : ''}</Text>
            </View>
          )}
          <TouchableOpacity
            style={[styles.primaryButton, !canSubmit && styles.primaryButtonDisabled]}
            onPress={editingId ? handleSaveEdit : scheduleType === 'now' ? handleSendNow : handleSchedule}
            disabled={!canSubmit}
          >
            {processing ? (
              <ActivityIndicator color={Colors.WHITE} />
            ) : (
              <Text style={styles.primaryButtonText}>
                {editingId ? 'Save Changes' : scheduleType === 'now' ? 'Send Now' : 'Schedule'}{total > 0 ? ` · ${formatNaira(total)}` : ''}
              </Text>
            )}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>

      <DateTimePickerModal
        visible={datePickerOpen}
        initial={scheduledDate}
        onClose={() => setDatePickerOpen(false)}
        onConfirm={(d) => { setScheduledDate(d); setDatePickerOpen(false); }}
      />

      <ContactPickerModal
        visible={pickerOpen}
        onClose={() => setPickerOpen(false)}
        multiSelect
        onSelectMultiple={addFromContacts}
      />

      {/* Data bundle picker */}
      <Modal visible={bundleFor !== null} animationType="slide" onRequestClose={() => setBundleFor(null)}>
        <SafeAreaView style={styles.container}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Select Data Plan</Text>
            <TouchableOpacity onPress={() => setBundleFor(null)}><Text style={styles.close}>✕</Text></TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={{ padding: Spacing.L }}>
            {(() => {
              const r = recipients.find((x) => x.id === bundleFor);
              if (!r) return null;
              const bundles = vtuService.getDataBundles(r.network);
              if (bundles.length === 0) {
                return <Text style={styles.emptyText}>No data plans available for {NETWORK_LABEL[r.network]}.</Text>;
              }
              return bundles.map((b) => (
                <TouchableOpacity
                  key={b.id}
                  style={styles.bundleRow}
                  onPress={() => { updateRecipient(r.id, { bundle: b }); setBundleFor(null); }}
                >
                  <View>
                    <Text style={styles.bundleName}>{b.name}</Text>
                    <Text style={styles.bundleValidity}>{b.validity}</Text>
                  </View>
                  <Text style={styles.bundlePrice}>{formatNaira(b.amount / 100)}</Text>
                </TouchableOpacity>
              ));
            })()}
          </ScrollView>
        </SafeAreaView>
      </Modal>

      {/* Manage scheduled payrolls */}
      <Modal visible={manageOpen} animationType="slide" onRequestClose={() => setManageOpen(false)}>
        <SafeAreaView style={styles.container}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Scheduled Payrolls</Text>
            <TouchableOpacity onPress={() => setManageOpen(false)}><Text style={styles.close}>✕</Text></TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={{ padding: Spacing.L }}>
            {loadingActive ? (
              <ActivityIndicator color={Colors.GREEN} style={{ marginTop: Spacing.XL }} />
            ) : active.length === 0 ? (
              <Text style={styles.emptyText}>No active scheduled payrolls.</Text>
            ) : (
              active.map((p) => (
                <View key={p.id} style={styles.manageCard}>
                  <View style={styles.manageInfo}>
                    <Text style={styles.manageTitle}>
                      {p.service_type === 'airtime' ? 'Airtime' : 'Data'} · {freqLabelShort(p.frequency)}
                    </Text>
                    <Text style={styles.manageSub}>
                      {formatNaira(p.total_amount / 100)}{p.frequency !== 'once' ? ` / ${p.frequency === 'weekly' ? 'week' : 'month'}` : ''} · {p.recipients.length} recipient(s)
                    </Text>
                    <Text style={styles.manageSub}>Next run: {new Date(p.next_run).toLocaleString()}</Text>
                  </View>
                  <View style={styles.manageActions}>
                    <TouchableOpacity style={styles.editBtn} onPress={() => startEdit(p)}>
                      <Text style={styles.editBtnText}>Edit</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.cancelBtn} onPress={() => handleCancelPayroll(p)}>
                      <Text style={styles.cancelBtnText}>Cancel</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ))
            )}
          </ScrollView>
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.WHITE },
  flex: { flex: 1 },
  scrollView: { flex: 1 },
  scrollContent: { paddingHorizontal: Spacing.SCREEN_PADDING, paddingTop: Spacing.M, paddingBottom: 150 },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: Spacing.S },
  backButton: { width: 48, height: 48, justifyContent: 'center', alignItems: 'center' },
  backText: { fontSize: 28, fontWeight: '600', color: Colors.DARK },
  manageLink: { ...Typography.BODY, color: Colors.GREEN, fontWeight: '600' },
  title: { ...Typography.SCREEN_TITLE, marginBottom: Spacing.XS },
  subtitle: { ...Typography.BODY, color: Colors.GRAY, marginBottom: Spacing.L },
  toggle: { flexDirection: 'row', backgroundColor: Colors.LIGHT_GRAY, borderRadius: Spacing.BUTTON_RADIUS, padding: 4, marginBottom: Spacing.L },
  toggleBtn: { flex: 1, paddingVertical: Spacing.M, alignItems: 'center', borderRadius: Spacing.BUTTON_RADIUS - 2 },
  toggleBtnActive: { backgroundColor: Colors.WHITE },
  toggleText: { ...Typography.BODY, color: Colors.GRAY, fontWeight: '600' },
  toggleTextActive: { color: Colors.DARK },
  addRow: { flexDirection: 'row', gap: Spacing.M, marginBottom: Spacing.L },
  addBtn: { flex: 1, height: Spacing.BUTTON_HEIGHT_SECONDARY, backgroundColor: Colors.GREEN, borderRadius: Spacing.BUTTON_RADIUS, justifyContent: 'center', alignItems: 'center' },
  addBtnText: { ...Typography.BUTTON_TEXT, color: Colors.WHITE },
  addBtnOutline: { paddingHorizontal: Spacing.L, height: Spacing.BUTTON_HEIGHT_SECONDARY, borderWidth: 1, borderColor: Colors.GREEN, borderRadius: Spacing.BUTTON_RADIUS, justifyContent: 'center', alignItems: 'center' },
  addBtnOutlineText: { ...Typography.BUTTON_TEXT, color: Colors.GREEN },
  emptyBox: { padding: Spacing.XL, borderWidth: 1, borderColor: Colors.BORDER, borderRadius: Spacing.CARD_RADIUS, borderStyle: 'dashed', marginBottom: Spacing.L },
  emptyText: { ...Typography.BODY, color: Colors.GRAY, textAlign: 'center' },
  recipientCard: { borderWidth: 1, borderColor: Colors.BORDER, borderRadius: Spacing.CARD_RADIUS, padding: Spacing.M, marginBottom: Spacing.M },
  recipientTop: { flexDirection: 'row', alignItems: 'center' },
  recipientInfo: { flex: 1, marginLeft: Spacing.M },
  recipientName: { ...Typography.BODY, fontWeight: '600', color: Colors.DARK },
  phoneInput: { ...Typography.BODY, color: Colors.DARK, paddingVertical: 2 },
  removeX: { fontSize: 18, color: Colors.GRAY, paddingHorizontal: Spacing.S },
  networkRow: { flexDirection: 'row', gap: Spacing.S, marginTop: Spacing.M },
  netChip: { paddingHorizontal: Spacing.M, height: 30, borderRadius: 15, borderWidth: 1, borderColor: Colors.BORDER, justifyContent: 'center', alignItems: 'center' },
  netChipActive: { borderColor: Colors.GREEN, backgroundColor: Colors.GREEN_LIGHT },
  netChipText: { ...Typography.CAPTION, color: Colors.DARK },
  netChipTextActive: { color: Colors.GREEN_DARK, fontWeight: '600' },
  amountRow: { flexDirection: 'row', alignItems: 'center', height: Spacing.INPUT_HEIGHT, borderWidth: Spacing.INPUT_BORDER_WIDTH, borderColor: Colors.BORDER, borderRadius: Spacing.BUTTON_RADIUS, paddingHorizontal: Spacing.L, marginTop: Spacing.M },
  currency: { ...Typography.BODY, fontWeight: '600', color: Colors.DARK, marginRight: Spacing.S },
  amountInput: { flex: 1, ...Typography.BODY, color: Colors.DARK },
  bundleBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', height: Spacing.INPUT_HEIGHT, borderWidth: Spacing.INPUT_BORDER_WIDTH, borderColor: Colors.BORDER, borderRadius: Spacing.BUTTON_RADIUS, paddingHorizontal: Spacing.L, marginTop: Spacing.M },
  bundleBtnText: { ...Typography.BODY, color: Colors.DARK, flex: 1 },
  bundleBtnPlaceholder: { color: Colors.GRAY },
  bundleArrow: { ...Typography.BODY, color: Colors.GRAY },
  section: { marginTop: Spacing.L, marginBottom: Spacing.XL },
  label: { ...Typography.SECTION_HEADING, marginBottom: Spacing.M },
  scheduleInputs: { marginTop: Spacing.L },
  freqRow: { flexDirection: 'row', gap: Spacing.S, marginBottom: Spacing.L },
  freqChip: { flex: 1, paddingVertical: Spacing.M, borderRadius: Spacing.BUTTON_RADIUS, borderWidth: 1, borderColor: Colors.BORDER, alignItems: 'center' },
  freqChipActive: { borderColor: Colors.GREEN, backgroundColor: Colors.GREEN_LIGHT },
  freqChipText: { ...Typography.CAPTION, color: Colors.DARK },
  freqChipTextActive: { color: Colors.GREEN_DARK, fontWeight: '600' },
  fieldLabel: { ...Typography.CAPTION, color: Colors.GRAY, marginBottom: Spacing.S },
  dateBtn: {
    height: Spacing.INPUT_HEIGHT,
    borderWidth: Spacing.INPUT_BORDER_WIDTH,
    borderColor: Colors.BORDER,
    borderRadius: Spacing.BUTTON_RADIUS,
    paddingHorizontal: Spacing.L,
    justifyContent: 'center',
    marginBottom: Spacing.M,
  },
  dateBtnText: { ...Typography.BODY, color: Colors.DARK },
  dateBtnPlaceholder: { color: Colors.GRAY },
  cancelEditBtn: { alignSelf: 'flex-start', marginBottom: Spacing.M },
  cancelEditText: { ...Typography.BODY, color: Colors.RED, fontWeight: '600' },
  debitNote: { ...Typography.CAPTION, color: Colors.GRAY },
  bottomBar: { position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: Colors.WHITE, borderTopWidth: 1, borderTopColor: Colors.BORDER, paddingHorizontal: Spacing.SCREEN_PADDING, paddingTop: Spacing.L },
  summary: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: Spacing.L },
  summaryLabel: { ...Typography.BODY, color: Colors.GRAY },
  summaryTotal: { ...Typography.AMOUNT_SMALL },
  primaryButton: { height: Spacing.BUTTON_HEIGHT_PRIMARY, backgroundColor: Colors.GREEN, borderRadius: Spacing.BUTTON_RADIUS, justifyContent: 'center', alignItems: 'center' },
  primaryButtonDisabled: { opacity: 0.5 },
  primaryButtonText: { ...Typography.BUTTON_TEXT, color: Colors.WHITE },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: Spacing.L, paddingVertical: Spacing.M, borderBottomWidth: 1, borderBottomColor: Colors.BORDER },
  modalTitle: { ...Typography.SCREEN_TITLE },
  close: { fontSize: 22, color: Colors.DARK, paddingHorizontal: Spacing.S },
  bundleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: Spacing.M, borderBottomWidth: 1, borderBottomColor: Colors.BORDER },
  bundleName: { ...Typography.BODY, color: Colors.DARK, fontWeight: '600' },
  bundleValidity: { ...Typography.CAPTION, color: Colors.GRAY, marginTop: 2 },
  bundlePrice: { ...Typography.BODY, color: Colors.GREEN, fontWeight: '700' },
  manageCard: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: Colors.BORDER, borderRadius: Spacing.CARD_RADIUS, padding: Spacing.M, marginBottom: Spacing.M },
  manageInfo: { flex: 1 },
  manageTitle: { ...Typography.BODY, fontWeight: '700', color: Colors.DARK },
  manageSub: { ...Typography.CAPTION, color: Colors.GRAY, marginTop: 2 },
  manageActions: { alignItems: 'flex-end', gap: Spacing.S },
  editBtn: { paddingHorizontal: Spacing.L, height: 34, borderRadius: Spacing.BUTTON_RADIUS, borderWidth: 1, borderColor: Colors.GREEN, justifyContent: 'center', alignItems: 'center' },
  editBtnText: { ...Typography.CAPTION, color: Colors.GREEN, fontWeight: '700' },
  cancelBtn: { paddingHorizontal: Spacing.L, height: 34, borderRadius: Spacing.BUTTON_RADIUS, borderWidth: 1, borderColor: Colors.RED, justifyContent: 'center', alignItems: 'center' },
  cancelBtnText: { ...Typography.CAPTION, color: Colors.RED, fontWeight: '700' },
});
