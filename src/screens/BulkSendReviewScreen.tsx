import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  FlatList,
  Modal,
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
import { supabase } from '../lib/supabase';
import { useTransactionAuth } from '../components/TransactionAuthProvider';
import { PickedContact } from '../services/contacts.service';
import { NETWORK_LABEL, NETWORK_COLOR, NgNetwork } from '../utils/phone';
import { formatNigerianPhone } from '../utils/detectNetwork';
import { NETWORK_LOGOS } from '../utils/providerLogos';
import ProviderLogo from '../components/ProviderLogo';
import { isRestrictedPlanName } from '../utils/planWarnings';
import ContactPickerModal from '../components/ContactPickerModal';

type SendType = 'airtime' | 'data';
type Phase = 'review' | 'sending' | 'done';

interface BulkSendReviewScreenProps {
  navigation: any;
  route: any;
}

// Contact-based network detection is prefix-only and has no idea a number
// has been ported to a different carrier (common in Nigeria) — this is why
// `network` is a separate, overridable field rather than always reading
// `contact.network` directly. The single-recipient Airtime/Data screens
// already let the user correct a wrong auto-detected guess via a network
// chip picker before paying; bulk send had no equivalent, so a ported
// number would silently go to the wrong carrier with no way to catch it
// before sending.
interface AirtimeRow {
  contact: PickedContact;
  network: NgNetwork;
  amount: string;
  // True once this recipient's amount has been typed by hand. The
  // "amount for everyone" control deliberately skips these rows, so setting
  // a batch-wide amount never silently wipes a deliberate per-person figure.
  // "Reset all" is the explicit way to clear the overrides.
  custom: boolean;
}

interface DataRow {
  contact: PickedContact;
  network: NgNetwork;
  bundle: DataBundle | null;
}

const QUICK_AMOUNTS = [100, 200, 500, 1000];

// Server-enforced floor (AIRTIME_MIN in _shared/vtu-catalog.ts) — the
// provider rejects anything below it. Shown up front so the amount is
// corrected before paying rather than after a failed purchase.
const AIRTIME_MIN = 100;

// Distinct-but-muted fills so a long recipient list stays scannable. Chosen
// per recipient from their phone number, so the same person keeps the same
// colour every time the screen is opened.
const AVATAR_COLORS = ['#7C3AED', '#1E40AF', '#B45309', Colors.GREEN_MID, '#BE185D', '#0F766E'];

function avatarColor(phone: string): string {
  let hash = 0;
  for (let i = 0; i < phone.length; i++) hash = (hash * 31 + phone.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

// Array.from rather than slice/charAt: a contact saved as a single emoji
// (which real phonebooks are full of) is a multi-code-unit character, and
// slicing it by code unit renders a broken glyph.
function initialsFor(name: string, phone: string): string {
  const words = (name || '').trim().split(/\s+/).filter(Boolean);
  const initials = words.slice(0, 2).map((word) => Array.from(word)[0] ?? '').join('');
  return initials || phone.slice(-2);
}

export default function BulkSendReviewScreen({ navigation, route }: BulkSendReviewScreenProps) {
  const { type, recipients }: { type: SendType; recipients: PickedContact[] } = route.params;
  const { authorize } = useTransactionAuth();
  const insets = useSafeAreaInsets();

  const [airtimeRows, setAirtimeRows] = useState<AirtimeRow[]>(
    recipients.map((contact) => ({ contact, network: contact.network, amount: '', custom: false })),
  );
  // The batch-wide amount. Bulk send previously had no such control at all,
  // so "bulk" airtime meant typing the same figure once per recipient — the
  // work grew linearly with the number of people, which is the opposite of
  // what the feature is for.
  const [bulkAmount, setBulkAmount] = useState('');
  const [dataRows, setDataRows] = useState<DataRow[]>(
    recipients.map((contact) => ({ contact, network: contact.network, bundle: null })),
  );
  const [walletBalance, setWalletBalance] = useState<number | null>(null);
  const [phase, setPhase] = useState<Phase>('review');
  const [results, setResults] = useState<Record<string, BatchResultItem>>({});
  // Data bundles are read from a local per-network cache (see
  // vtu.service.ts's getDataBundles) that's only populated once the user
  // has visited the Data screen for that network before. A bulk send can
  // easily include a network the cache has never seen, which would
  // otherwise show that recipient's row with zero bundle options and no
  // explanation. Refresh every distinct network in this batch up front.
  const [bundlesReady, setBundlesReady] = useState(type !== 'data');
  // Phone of the recipient whose plan-picker modal is open, or null. A
  // cramped horizontal chip scroll doesn't work once a plan's own name is
  // long (e.g. VTUnaija's restricted-plan names embed a full warning
  // sentence, "Do Not Buy MTN AwoofData If You Are Owing MTN Airtime") — a
  // long first plan can fill the entire visible width and hide every other
  // option off-screen with no hint to scroll. A modal with a proper
  // vertical, scrollable list has no such limit.
  const [planModalFor, setPlanModalFor] = useState<string | null>(null);
  // Phone of the recipient currently being swapped for a different contact,
  // or null. There was previously no way to fix a mis-picked contact short
  // of backing out of the whole batch and re-selecting everyone — tapping a
  // recipient's name/number now reopens the contacts picker scoped to just
  // that one row.
  const [contactPickerFor, setContactPickerFor] = useState<string | null>(null);
  // Whether the "Add More" contacts picker (multi-select) is open — lets
  // more recipients be appended to an already-built batch instead of
  // forcing the user to back out and re-pick everyone from scratch.
  const [addMoreOpen, setAddMoreOpen] = useState(false);

  // Read the latest results inside the poll without making it a dependency
  // (which would tear down and restart the interval on every settle).
  const resultsRef = useRef(results);
  useEffect(() => {
    resultsRef.current = results;
  }, [results]);

  useEffect(() => {
    walletService.getWallet().then((res) => {
      if (res.success && res.wallet) setWalletBalance(res.wallet.available_balance);
    });
  }, []);

  useEffect(() => {
    if (type !== 'data') return;
    const distinctNetworks = Array.from(new Set(recipients.map((c) => c.network)));
    Promise.all(distinctNetworks.map((n) => vtuService.refreshDataBundles(n))).finally(() => {
      setBundlesReady(true);
    });
    // recipients/type are fixed for the lifetime of this screen (route params).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // There was previously no way to fix a mis-picked contact short of
  // backing out of the whole batch and re-selecting everyone from scratch.
  // Tapping a recipient's name/number reopens the contacts picker
  // (single-select) scoped to just that one row; picking someone replaces
  // the contact in place, keeping whatever amount/plan was already entered
  // for that slot.
  const handleContactSwap = useCallback((newContact: PickedContact) => {
    const oldPhone = contactPickerFor;
    setContactPickerFor(null);
    if (!oldPhone || newContact.phone === oldPhone) return;

    if (newContact.network === '9mobile') {
      Alert.alert('Network unavailable', '9mobile purchases are currently unavailable.');
      return;
    }
    const currentRows = type === 'airtime' ? airtimeRows : dataRows;
    if (currentRows.some((r) => r.contact.phone === newContact.phone)) {
      Alert.alert('Already in this batch', `${newContact.name} is already one of the recipients.`);
      return;
    }

    if (type === 'airtime') {
      setAirtimeRows((prev) =>
        prev.map((r) =>
          r.contact.phone === oldPhone ? { ...r, contact: newContact, network: newContact.network } : r,
        ),
      );
    } else {
      setDataRows((prev) =>
        prev.map((r) => {
          if (r.contact.phone !== oldPhone) return r;
          const networkChanged = r.network !== newContact.network;
          return { ...r, contact: newContact, network: newContact.network, bundle: networkChanged ? null : r.bundle };
        }),
      );
      if (!vtuService.hasCachedDataBundles(newContact.network)) {
        vtuService.refreshDataBundles(newContact.network);
      }
    }
  }, [contactPickerFor, type, airtimeRows, dataRows]);

  const handleRemoveRecipient = useCallback((phone: string) => {
    if (type === 'airtime') {
      if (airtimeRows.length <= 1) return;
      setAirtimeRows((prev) => prev.filter((r) => r.contact.phone !== phone));
    } else {
      if (dataRows.length <= 1) return;
      setDataRows((prev) => prev.filter((r) => r.contact.phone !== phone));
    }
  }, [type, airtimeRows.length, dataRows.length]);

  // Appends newly-picked contacts onto the existing batch instead of
  // forcing the user to cancel and rebuild the whole selection to add a
  // few more people.
  const handleAddMoreContacts = useCallback((picked: PickedContact[]) => {
    setAddMoreOpen(false);
    const currentRows = type === 'airtime' ? airtimeRows : dataRows;
    const existingPhones = new Set(currentRows.map((r) => r.contact.phone));
    const seenInThisPick = new Set<string>();
    const toAdd: PickedContact[] = [];
    let skipped9mobile = 0;
    let skippedDuplicate = 0;

    for (const contact of picked) {
      if (contact.network === '9mobile') {
        skipped9mobile++;
        continue;
      }
      if (existingPhones.has(contact.phone) || seenInThisPick.has(contact.phone)) {
        skippedDuplicate++;
        continue;
      }
      seenInThisPick.add(contact.phone);
      toAdd.push(contact);
    }

    if (toAdd.length === 0) {
      if (skipped9mobile > 0 || skippedDuplicate > 0) {
        Alert.alert(
          'Nothing added',
          skipped9mobile > 0 && skippedDuplicate > 0
            ? 'Those contacts are already in this batch or on 9mobile, which is unsupported.'
            : skipped9mobile > 0
            ? '9mobile is currently unsupported.'
            : 'Those contacts are already in this batch.',
        );
      }
      return;
    }

    if (type === 'airtime') {
      setAirtimeRows((prev) => [
        ...prev,
        // Inherit the batch-wide amount so someone added late is immediately
        // ready to send, rather than silently reintroducing a blank row that
        // blocks the whole batch.
        ...toAdd.map((contact) => ({
          contact,
          network: contact.network,
          amount: bulkAmount,
          custom: false,
        })),
      ]);
    } else {
      setDataRows((prev) => [
        ...prev,
        ...toAdd.map((contact) => ({ contact, network: contact.network, bundle: null })),
      ]);
      // Same reasoning as the contact-swap path: a newly added recipient can
      // land on a network the cache never saw, so refresh anything not
      // already covered rather than let that row's plan picker start empty.
      const newNetworks = Array.from(new Set(toAdd.map((c) => c.network)));
      newNetworks
        .filter((n) => !vtuService.hasCachedDataBundles(n))
        .forEach((n) => vtuService.refreshDataBundles(n));
    }

    if (skipped9mobile > 0 || skippedDuplicate > 0) {
      const parts: string[] = [];
      if (skippedDuplicate > 0) parts.push(`${skippedDuplicate} already in this batch`);
      if (skipped9mobile > 0) parts.push(`${skipped9mobile} on 9mobile`);
      Alert.alert('Added with exceptions', `Added ${toAdd.length}. Skipped: ${parts.join(', ')}.`);
    }
  }, [type, airtimeRows, dataRows]);

  // Once submitted, the provider settles each order in the background. Poll the
  // still-pending transactions until each reaches a terminal state so a later
  // refund is reflected as ✗ instead of being hidden behind a premature ✓.
  useEffect(() => {
    if (phase !== 'done') return;
    const startedAt = Date.now();
    const interval = setInterval(async () => {
      const pending = Object.values(resultsRef.current).filter(
        (r) => r.success && r.pending && r.transaction_id,
      );
      // Give up after 60s — reconcile + notifications finish the rest.
      if (pending.length === 0 || Date.now() - startedAt > 60000) {
        clearInterval(interval);
        return;
      }
      try {
        const ids = pending.map((r) => r.transaction_id as string);
        const { data } = await supabase
          .from('transactions')
          .select('id, status')
          .in('id', ids);
        if (!data || data.length === 0) return;
        const statusById = new Map(data.map((row: any) => [row.id, row.status]));
        setResults((prev) => {
          const next = { ...prev };
          for (const entry of Object.values(prev)) {
            if (!entry.pending || !entry.transaction_id) continue;
            const s = statusById.get(entry.transaction_id);
            if (s === 'completed') {
              next[entry.phone] = { ...entry, pending: false, success: true };
            } else if (s === 'failed' || s === 'refunded') {
              next[entry.phone] = { ...entry, pending: false, success: false, error: 'Refunded' };
            }
          }
          return next;
        });
      } catch {
        /* transient — keep polling */
      }
    }, 2000);
    return () => clearInterval(interval);
  }, [phase]);

  // Derived from the live rows, not the static route-param `recipients` —
  // swapping or removing a recipient changes the row arrays, and the
  // header/footer counts need to track that instead of staying frozen at
  // whatever was picked on the previous screen.
  const recipientCount = type === 'airtime' ? airtimeRows.length : dataRows.length;

  const total = useMemo(() => {
    if (type === 'airtime') {
      return airtimeRows.reduce((sum, r) => sum + (parseInt(r.amount, 10) || 0), 0);
    }
    return dataRows.reduce((sum, r) => sum + (r.bundle?.amount ?? 0), 0);
  }, [type, airtimeRows, dataRows]);

  const canSend = useMemo(() => {
    if (type === 'airtime') {
      // Enforce the provider's real floor here too. Previously any amount
      // above zero passed this check and only failed at the provider, after
      // the batch had been authorised.
      return airtimeRows.every((r) => {
        const n = parseInt(r.amount, 10);
        return !isNaN(n) && n >= AIRTIME_MIN;
      });
    }
    return bundlesReady && dataRows.every((r) => r.bundle !== null);
  }, [type, airtimeRows, dataRows, bundlesReady]);

  const customCount = useMemo(
    () => (type === 'airtime' ? airtimeRows.filter((r) => r.custom && r.amount).length : 0),
    [type, airtimeRows],
  );

  // Lets the batch's network split be confirmed before paying. On a long
  // list an unexpected carrier is otherwise easy to miss, and airtime sent
  // to the wrong network fails at the provider after the debit.
  const networkSummary = useMemo(() => {
    const counts = new Map<NgNetwork, number>();
    const rows: { network: NgNetwork }[] = type === 'airtime' ? airtimeRows : dataRows;
    rows.forEach((r) => counts.set(r.network, (counts.get(r.network) ?? 0) + 1));
    return Array.from(counts.entries());
  }, [type, airtimeRows, dataRows]);

  const insufficientBalance = walletBalance !== null && total > walletBalance;

  const activePlanRow = useMemo(
    () => dataRows.find((r) => r.contact.phone === planModalFor) ?? null,
    [dataRows, planModalFor],
  );
  const activePlanBundles = useMemo(
    () => (activePlanRow ? vtuService.getDataBundles(activePlanRow.network) : []),
    [activePlanRow],
  );

  // Editing one recipient's amount marks that row custom, which exempts it
  // from any later batch-wide change.
  const handleAirtimeAmountChange = useCallback((phone: string, text: string) => {
    const cleaned = text.replace(/[^0-9]/g, '').slice(0, 6);
    setAirtimeRows((prev) =>
      prev.map((r) => (r.contact.phone === phone ? { ...r, amount: cleaned, custom: true } : r)),
    );
  }, []);

  // Typing in, or tapping a chip on, the "amount for everyone" control. Both
  // paths land here so the field always reflects what will actually be sent,
  // and both skip rows the user has already set by hand.
  const applyBulkAmount = useCallback((text: string) => {
    const cleaned = text.replace(/[^0-9]/g, '').slice(0, 6);
    setBulkAmount(cleaned);
    setAirtimeRows((prev) => prev.map((r) => (r.custom ? r : { ...r, amount: cleaned })));
  }, []);

  // Drops every per-person override and puts the whole batch back on the
  // shared amount — the explicit undo for custom rows.
  const handleResetAmounts = useCallback(() => {
    setAirtimeRows((prev) => prev.map((r) => ({ ...r, amount: bulkAmount, custom: false })));
  }, [bulkAmount]);

  const applyBundleSelection = useCallback((phone: string, bundle: DataBundle) => {
    setDataRows((prev) =>
      prev.map((r) => (r.contact.phone === phone ? { ...r, bundle } : r)),
    );
    setPlanModalFor(null);
  }, []);

  // Same restricted-plan confirmation the single-recipient Data screen
  // already has (see DataScreen.tsx's handleBundleSelect) — bulk send had
  // no equivalent, so a plan whose own name is a literal "Do Not Buy...
  // Owing Airtime" warning could be selected with zero friction, which is
  // exactly what happened in testing (a recipient ended up with one of
  // these selected, unnoticed, because it was also the first — and only
  // visible — option in the old cramped horizontal layout).
  const handleBundleSelect = useCallback((phone: string, bundle: DataBundle) => {
    if (isRestrictedPlanName(bundle.name)) {
      const network = dataRows.find((r) => r.contact.phone === phone)?.network;
      Alert.alert(
        'Restricted plan',
        `This plan can fail if this recipient owes airtime on ${network ? NETWORK_LABEL[network] : 'this network'}. Only continue if you're sure they have no outstanding airtime balance.`,
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Continue', onPress: () => applyBundleSelection(phone, bundle) },
        ],
      );
      return;
    }
    applyBundleSelection(phone, bundle);
  }, [dataRows, applyBundleSelection]);

  const handleSend = useCallback(async () => {
    if (!canSend) return;
    if (insufficientBalance) {
      Alert.alert(
        'Insufficient Balance',
        `This batch needs ${formatNaira(total)}, but your available balance is ${formatNaira(walletBalance ?? 0)}.`,
      );
      return;
    }

    // A step-up token use is consumed server-side on every vtu-purchase call,
    // including a client-side retry of an ambiguous/timed-out attempt (the
    // server's own idempotency check happens later, inside the debit RPC —
    // it safely no-ops a genuine retry's debit, but the token use is already
    // spent by then). With maxUses sized exactly to recipientCount, a single
    // flaky network moment on one recipient could exhaust the token early
    // and fail later, unrelated recipients with an auth error the user has
    // no way to diagnose (they already entered their PIN once). This buffer
    // gives retries some headroom without weakening the PIN gate itself.
    const maxUses = recipientCount + Math.max(2, Math.ceil(recipientCount * 0.2));
    const authResult = await authorize({
      title: `Confirm Bulk ${type === 'airtime' ? 'Airtime' : 'Data'} Send`,
      amount: total,
      // One PIN entry authorizes the whole batch — a prompt per recipient
      // would be unusable. See TransactionAuthProvider's maxUses option.
      maxUses,
    });
    if (!authResult) return;

    setResults({});
    setPhase('sending');

    if (type === 'airtime') {
      await vtuService.buyAirtimeBatch(
        airtimeRows.map((r) => ({
          phone: r.contact.phone,
          network: r.network,
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
          .map((r) => ({ phone: r.contact.phone, network: r.network, bundle: r.bundle })),
        authResult.token,
        (_, result) => {
          setResults((prev) => ({ ...prev, [result.phone]: result }));
        },
      );
    }

    setPhase('done');
  }, [canSend, insufficientBalance, total, walletBalance, type, airtimeRows, dataRows, authorize]);

  const successCount = Object.values(results).filter((r) => r.success && !r.pending).length;
  const pendingCount = Object.values(results).filter((r) => r.success && r.pending).length;
  const failedCount = Object.values(results).filter((r) => !r.success).length;

  const renderStatusIcon = (phone: string) => {
    const result = results[phone];
    // Spinner while a recipient is either still being submitted, or submitted
    // and awaiting its background settlement.
    if ((phase === 'sending' && !result) || (result?.success && result.pending)) {
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
  const submittedCount = Object.keys(results).length;

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
          <View style={styles.subtitleRow}>
            <Text style={styles.subtitle}>
              {recipientCount} recipient{recipientCount === 1 ? '' : 's'}
            </Text>
            {!locked && (
              <TouchableOpacity
                style={styles.addMoreButton}
                onPress={() => setAddMoreOpen(true)}
                activeOpacity={0.7}
              >
                <Text style={styles.addMoreButtonText}>+ Add More</Text>
              </TouchableOpacity>
            )}
          </View>

          {phase !== 'review' ? (
            <View style={styles.submissionCard}>
              <View style={styles.submissionIcon}>
                {phase === 'sending' ? (
                  <ActivityIndicator size="large" color={Colors.GREEN} />
                ) : (
                  <Text style={styles.submissionCheck}>✓</Text>
                )}
              </View>
              <Text style={styles.submissionTitle}>
                {phase === 'sending' ? 'Bulk payment submitted' : 'Bulk payment processed'}
              </Text>
              <Text style={styles.submissionMessage}>
                {phase === 'sending'
                  ? `We are processing ${recipientCount} ${type} purchase${recipientCount === 1 ? '' : 's'}. You can leave this page while the remaining requests are completed.`
                  : failedCount > 0 || pendingCount > 0
                    ? 'Processing is complete for now. Review the summary below for any pending or failed purchases.'
                    : `All ${recipientCount} ${type} purchase${recipientCount === 1 ? '' : 's'} completed successfully.`}
              </Text>
              <View style={styles.submissionProgressRow}>
                <Text style={styles.submissionProgressLabel}>
                  {phase === 'sending' ? 'Submitted' : 'Processed'}
                </Text>
                <Text style={styles.submissionProgressValue}>
                  {phase === 'sending' ? submittedCount : recipientCount} of {recipientCount}
                </Text>
              </View>
              {phase === 'done' && (
                <View style={styles.resultSummaryRow}>
                  <View style={styles.resultSummaryItem}>
                    <Text style={[styles.resultSummaryValue, styles.resultSuccess]}>{successCount}</Text>
                    <Text style={styles.resultSummaryLabel}>Successful</Text>
                  </View>
                  <View style={styles.resultSummaryItem}>
                    <Text style={[styles.resultSummaryValue, styles.resultPending]}>{pendingCount}</Text>
                    <Text style={styles.resultSummaryLabel}>Processing</Text>
                  </View>
                  <View style={styles.resultSummaryItem}>
                    <Text style={[styles.resultSummaryValue, styles.resultFailed]}>{failedCount}</Text>
                    <Text style={styles.resultSummaryLabel}>Failed</Text>
                  </View>
                </View>
              )}
            </View>
          ) : type === 'airtime'
            ? (
              <>
                {!locked && (
                  <View style={styles.bulkAmountCard}>
                    <Text style={styles.bulkAmountLabel}>Amount for everyone</Text>
                    {/* A real input, not a display value: the previous screen
                        showed the figure as plain text, which gave no hint it
                        could be typed into. */}
                    <View style={styles.bulkAmountField}>
                      <Text style={styles.bulkAmountCurrency}>₦</Text>
                      <TextInput
                        style={styles.bulkAmountInput}
                        placeholder="Type amount"
                        placeholderTextColor="#AFB6B3"
                        value={bulkAmount}
                        onChangeText={applyBulkAmount}
                        keyboardType="numeric"
                      />
                      {bulkAmount.length > 0 && (
                        <TouchableOpacity
                          style={styles.bulkAmountClear}
                          onPress={() => applyBulkAmount('')}
                          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                          activeOpacity={0.7}
                        >
                          <Text style={styles.bulkAmountClearText}>✕</Text>
                        </TouchableOpacity>
                      )}
                    </View>
                    <View style={styles.bulkChipsRow}>
                      {QUICK_AMOUNTS.map((qa) => (
                        <TouchableOpacity
                          key={qa}
                          style={[
                            styles.bulkChip,
                            bulkAmount === String(qa) && styles.bulkChipSelected,
                          ]}
                          onPress={() => applyBulkAmount(String(qa))}
                          activeOpacity={0.7}
                        >
                          <Text
                            style={[
                              styles.bulkChipText,
                              bulkAmount === String(qa) && styles.bulkChipTextSelected,
                            ]}
                          >
                            {formatNaira(qa)}
                          </Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                    <View style={styles.bulkHintRow}>
                      <Text style={styles.bulkHintText}>
                        {customCount > 0
                          ? `Applied to ${recipientCount - customCount} of ${recipientCount}`
                          : 'Tap an amount or type your own'}
                      </Text>
                      <Text style={styles.bulkHintText}>Min {formatNaira(AIRTIME_MIN)}</Text>
                    </View>
                  </View>
                )}

                <View style={styles.listHeaderRow}>
                  <Text style={styles.listHeaderTitle}>Recipients</Text>
                  {!locked && customCount > 0 && (
                    <TouchableOpacity onPress={handleResetAmounts} activeOpacity={0.7}>
                      <Text style={styles.listHeaderAction}>Reset all</Text>
                    </TouchableOpacity>
                  )}
                </View>

                {airtimeRows.map((row) => {
                  const hasName = !!row.contact.name && row.contact.name !== row.contact.phone;
                  const prettyPhone = formatNigerianPhone(row.contact.phone);
                  return (
                    <View key={row.contact.phone} style={styles.recipientRow}>
                      <TouchableOpacity
                        style={styles.recipientMain}
                        onPress={() => setContactPickerFor(row.contact.phone)}
                        disabled={locked}
                        activeOpacity={0.7}
                      >
                        <View
                          style={[
                            styles.avatar,
                            { backgroundColor: avatarColor(row.contact.phone) },
                          ]}
                        >
                          <Text style={styles.avatarText}>
                            {initialsFor(row.contact.name, row.contact.phone)}
                          </Text>
                        </View>
                        <View style={styles.recipientWho}>
                          {/* The number is always visible on its own line, so
                              identity never depends on what the contact was
                              saved as — a phonebook entry of a single emoji
                              used to leave the row unidentifiable. */}
                          <Text style={styles.recipientName} numberOfLines={1}>
                            {hasName ? row.contact.name : prettyPhone}
                          </Text>
                          <View style={styles.recipientMetaRow}>
                            <View
                              style={[
                                styles.networkPill,
                                { backgroundColor: NETWORK_COLOR[row.network] },
                              ]}
                            >
                              <Text
                                style={[
                                  styles.networkPillText,
                                  row.network === 'mtn' && styles.networkPillTextDark,
                                ]}
                              >
                                {NETWORK_LABEL[row.network]}
                              </Text>
                            </View>
                            <Text style={styles.recipientNumber} numberOfLines={1}>
                              {hasName ? prettyPhone : 'Not in contacts'}
                            </Text>
                          </View>
                        </View>
                      </TouchableOpacity>

                      <View style={styles.recipientAmountCol}>
                        <TextInput
                          style={[
                            styles.recipientAmountInput,
                            row.custom && !!row.amount && styles.recipientAmountInputCustom,
                          ]}
                          value={row.amount ? `₦${row.amount}` : ''}
                          placeholder="₦0"
                          placeholderTextColor="#B6BDBA"
                          onChangeText={(text) => handleAirtimeAmountChange(row.contact.phone, text)}
                          keyboardType="numeric"
                          editable={!locked}
                        />
                        {row.custom && !!row.amount && (
                          <Text style={styles.recipientCustomTag}>CUSTOM</Text>
                        )}
                      </View>

                      <View style={styles.recipientEnd}>
                        {renderStatusIcon(row.contact.phone)}
                        {!locked && recipientCount > 1 && (
                          <TouchableOpacity
                            onPress={() => handleRemoveRecipient(row.contact.phone)}
                            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                            activeOpacity={0.7}
                          >
                            <Text style={styles.recipientRemove}>✕</Text>
                          </TouchableOpacity>
                        )}
                      </View>
                    </View>
                  );
                })}
              </>
            )
            : dataRows.map((row) => {
                const bundles = vtuService.getDataBundles(row.network);
                return (
                  <View key={row.contact.phone} style={styles.card}>
                    <View style={styles.cardHeader}>
                      <View style={styles.cardHeaderMid}>
                        <TouchableOpacity
                          onPress={() => setContactPickerFor(row.contact.phone)}
                          disabled={locked}
                          activeOpacity={0.7}
                        >
                          <Text style={styles.name} numberOfLines={1}>
                            {row.contact.name}
                          </Text>
                          <View style={styles.numberRow}>
                            <Text style={styles.number}>{row.contact.phone}</Text>
                            {!locked && <Text style={styles.numberChangeHint}>Change contact</Text>}
                          </View>
                        </TouchableOpacity>
                        <View style={styles.networkBadge}>
                          <ProviderLogo
                            source={NETWORK_LOGOS[row.network]}
                            fallbackLabel={NETWORK_LABEL[row.network]}
                            fallbackColor={NETWORK_COLOR[row.network]}
                            size={22}
                          />
                          <Text style={styles.networkLabel}>
                            {NETWORK_LABEL[row.network]}
                          </Text>
                        </View>
                      </View>
                      <View style={styles.cardHeaderEnd}>
                        {renderStatusIcon(row.contact.phone)}
                        {!locked && recipientCount > 1 && (
                          <TouchableOpacity
                            style={styles.removeButton}
                            onPress={() => handleRemoveRecipient(row.contact.phone)}
                            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                            activeOpacity={0.7}
                          >
                            <Text style={styles.removeButtonText}>✕</Text>
                          </TouchableOpacity>
                        )}
                      </View>
                    </View>

                    {!bundlesReady ? (
                      <View style={styles.bundleLoadingRow}>
                        <ActivityIndicator size="small" color={Colors.GRAY} />
                        <Text style={styles.bundleLoadingText}>Loading plans…</Text>
                      </View>
                    ) : bundles.length === 0 ? (
                      <Text style={styles.bundleEmptyText}>
                        No {NETWORK_LABEL[row.network]} data plans available right now.
                      </Text>
                    ) : (
                      <TouchableOpacity
                        style={[styles.planSelectRow, row.bundle && styles.planSelectRowChosen]}
                        onPress={() => setPlanModalFor(row.contact.phone)}
                        disabled={locked}
                        activeOpacity={0.7}
                      >
                        {row.bundle ? (
                          <View style={styles.planSelectChosenText}>
                            <Text style={styles.planSelectChosenName} numberOfLines={1}>
                              {row.bundle.name}
                            </Text>
                            <Text style={styles.planSelectChosenPrice}>
                              {formatNaira(row.bundle.amount)}
                            </Text>
                          </View>
                        ) : (
                          <Text style={styles.planSelectPlaceholder}>Select a plan</Text>
                        )}
                        <Text style={styles.planSelectChevron}>{row.bundle ? 'Change' : '›'}</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                );
              })}
        </ScrollView>

        <View style={[styles.bottomContainer, { paddingBottom: insets.bottom + Spacing.SCREEN_PADDING }]}>
          {insufficientBalance && phase === 'review' && (
            <Text style={styles.insufficientText}>
              Insufficient balance for this total
            </Text>
          )}
          {phase === 'review' && networkSummary.length > 0 && (
            <View style={styles.footerNetworkRow}>
              {networkSummary.map(([network, count]) => (
                <View
                  key={network}
                  style={[styles.networkPill, { backgroundColor: NETWORK_COLOR[network] }]}
                >
                  <Text
                    style={[
                      styles.networkPillText,
                      network === 'mtn' && styles.networkPillTextDark,
                    ]}
                  >
                    {NETWORK_LABEL[network]} × {count}
                  </Text>
                </View>
              ))}
            </View>
          )}
          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>Total</Text>
            <Text style={styles.totalValue}>{formatNaira(total)}</Text>
          </View>
          {phase !== 'review' ? (
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
                (!canSend || insufficientBalance) &&
                  styles.actionButtonDisabled,
              ]}
              onPress={handleSend}
              disabled={!canSend || insufficientBalance}
              activeOpacity={0.8}
            >
              {/* States the actual commitment. A money button should say what
                  is about to happen, not just who it happens to. */}
              <Text style={styles.actionButtonText}>
                {canSend && total > 0
                  ? `Send ${formatNaira(total)} to ${recipientCount} ${recipientCount === 1 ? 'person' : 'people'}`
                  : `Send to ${recipientCount} recipient${recipientCount === 1 ? '' : 's'}`}
              </Text>
            </TouchableOpacity>
          )}
          {phase === 'review' && walletBalance !== null && canSend && !insufficientBalance && (
            <Text style={styles.balanceAfterText}>
              Wallet balance {formatNaira(walletBalance)} · {formatNaira(walletBalance - total)} left after
            </Text>
          )}
        </View>
      </KeyboardAvoidingView>

      <Modal
        visible={planModalFor !== null}
        animationType="slide"
        onRequestClose={() => setPlanModalFor(null)}
      >
        <SafeAreaView style={styles.container}>
          <View style={styles.planModalHeader}>
            <View style={styles.flex}>
              <Text style={styles.planModalTitle}>Select a Plan</Text>
              {activePlanRow && (
                <Text style={styles.planModalSubtitle} numberOfLines={1}>
                  {activePlanRow.contact.name} · {NETWORK_LABEL[activePlanRow.network]}
                </Text>
              )}
            </View>
            <TouchableOpacity
              onPress={() => setPlanModalFor(null)}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <Text style={styles.planModalClose}>✕</Text>
            </TouchableOpacity>
          </View>
          <FlatList
            data={activePlanBundles}
            keyExtractor={(b) => b.id}
            contentContainerStyle={styles.planModalList}
            ItemSeparatorComponent={() => <View style={styles.planModalSep} />}
            renderItem={({ item }) => {
              const restricted = isRestrictedPlanName(item.name);
              const isSelected = activePlanRow?.bundle?.id === item.id;
              return (
                <TouchableOpacity
                  style={[styles.planModalItem, isSelected && styles.planModalItemSelected]}
                  onPress={() => activePlanRow && handleBundleSelect(activePlanRow.contact.phone, item)}
                  activeOpacity={0.7}
                >
                  <View style={styles.flex}>
                    <Text style={styles.planModalItemName}>{item.name}</Text>
                    {restricted && (
                      <Text style={styles.planModalItemWarning}>⚠ Can fail if owing airtime</Text>
                    )}
                  </View>
                  <Text style={styles.planModalItemPrice}>{formatNaira(item.amount)}</Text>
                </TouchableOpacity>
              );
            }}
          />
        </SafeAreaView>
      </Modal>

      {contactPickerFor !== null && (
        <ContactPickerModal
          visible
          onClose={() => setContactPickerFor(null)}
          onSelect={handleContactSwap}
        />
      )}

      {addMoreOpen && (
        <ContactPickerModal
          visible
          multiSelect
          onClose={() => setAddMoreOpen(false)}
          onSelectMultiple={handleAddMoreContacts}
        />
      )}
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
  subtitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: Spacing.L,
  },
  subtitle: {
    ...Typography.BODY,
    color: Colors.GRAY,
  },
  addMoreButton: {
    height: Spacing.CHIP_HEIGHT,
    paddingHorizontal: Spacing.M,
    borderRadius: Spacing.CHIP_HEIGHT / 2,
    borderWidth: 1,
    borderColor: Colors.GREEN,
    justifyContent: 'center',
    alignItems: 'center',
  },
  addMoreButtonText: {
    ...Typography.CAPTION,
    color: Colors.GREEN,
    fontWeight: '700',
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
    alignItems: 'flex-start',
    marginBottom: Spacing.M,
  },
  cardHeaderMid: { flex: 1, marginRight: Spacing.M },
  cardHeaderEnd: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.S,
  },
  removeButton: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: Colors.LIGHT_GRAY,
    justifyContent: 'center',
    alignItems: 'center',
  },
  removeButtonText: { color: Colors.GRAY, fontSize: 14, fontWeight: '700' },
  name: { ...Typography.CARD_TITLE },
  numberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 2,
  },
  number: { ...Typography.CAPTION, color: Colors.GRAY, marginRight: Spacing.S },
  numberChangeHint: {
    ...Typography.CAPTION,
    color: Colors.GREEN,
    fontWeight: '600',
  },
  networkLabel: {
    ...Typography.CAPTION,
    color: Colors.GRAY,
    marginLeft: Spacing.S,
  },
  networkBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 2,
  },
  bundleLoadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: Spacing.S,
  },
  bundleLoadingText: {
    ...Typography.CAPTION,
    color: Colors.GRAY,
    marginLeft: Spacing.S,
  },
  bundleEmptyText: {
    ...Typography.CAPTION,
    color: Colors.GRAY,
  },
  statusSuccess: { color: Colors.GREEN, fontSize: 20, fontWeight: '700' },
  statusFailed: { color: Colors.RED, fontSize: 20, fontWeight: '700' },
  planSelectRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: Spacing.INPUT_HEIGHT,
    paddingHorizontal: Spacing.L,
    borderWidth: Spacing.INPUT_BORDER_WIDTH,
    borderColor: Colors.BORDER,
    borderRadius: Spacing.BUTTON_RADIUS,
  },
  planSelectRowChosen: {
    borderColor: Colors.GREEN,
  },
  planSelectPlaceholder: { ...Typography.BODY, color: Colors.GRAY },
  planSelectChosenText: { flex: 1, marginRight: Spacing.M },
  planSelectChosenName: { ...Typography.BODY, color: Colors.DARK, fontWeight: '600' },
  planSelectChosenPrice: { ...Typography.CAPTION, color: Colors.GREEN, marginTop: 2 },
  planSelectChevron: { ...Typography.CAPTION, color: Colors.GREEN, fontWeight: '700' },
  planModalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.L,
    paddingVertical: Spacing.M,
    borderBottomWidth: 1,
    borderBottomColor: Colors.BORDER,
  },
  planModalTitle: { ...Typography.SCREEN_TITLE },
  planModalSubtitle: { ...Typography.CAPTION, color: Colors.GRAY, marginTop: 2 },
  planModalClose: { fontSize: 22, color: Colors.DARK, paddingHorizontal: Spacing.S },
  planModalList: { paddingHorizontal: Spacing.L, paddingBottom: Spacing.XL },
  planModalSep: { height: 1, backgroundColor: Colors.BORDER },
  planModalItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: Spacing.M,
  },
  planModalItemSelected: {
    backgroundColor: Colors.GREEN_LIGHT,
    marginHorizontal: -Spacing.L,
    paddingHorizontal: Spacing.L,
  },
  planModalItemName: { ...Typography.BODY, color: Colors.DARK, flexShrink: 1 },
  planModalItemWarning: {
    ...Typography.CAPTION,
    color: Colors.RED,
    marginTop: 2,
  },
  planModalItemPrice: {
    ...Typography.BODY,
    color: Colors.GREEN,
    fontWeight: '700',
    marginLeft: Spacing.M,
  },
  submissionCard: {
    borderWidth: 1,
    borderColor: Colors.BORDER,
    borderRadius: Spacing.CARD_RADIUS,
    padding: Spacing.XL,
    alignItems: 'center',
    backgroundColor: Colors.WHITE,
  },
  submissionIcon: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.GREEN_LIGHT,
    marginBottom: Spacing.L,
  },
  submissionCheck: { color: Colors.GREEN, fontSize: 38, fontWeight: '700' },
  submissionTitle: {
    ...Typography.CARD_TITLE,
    color: Colors.DARK,
    textAlign: 'center',
    marginBottom: Spacing.S,
  },
  submissionMessage: {
    ...Typography.BODY,
    color: Colors.GRAY,
    textAlign: 'center',
    lineHeight: 22,
  },
  submissionProgressRow: {
    width: '100%',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingTop: Spacing.L,
    marginTop: Spacing.L,
    borderTopWidth: 1,
    borderTopColor: Colors.BORDER,
  },
  submissionProgressLabel: { ...Typography.BODY, color: Colors.GRAY },
  submissionProgressValue: { ...Typography.BODY, color: Colors.DARK, fontWeight: '700' },
  resultSummaryRow: {
    width: '100%',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: Spacing.L,
  },
  resultSummaryItem: { flex: 1, alignItems: 'center' },
  resultSummaryValue: { fontSize: 22, fontWeight: '700' },
  resultSummaryLabel: { ...Typography.CAPTION, color: Colors.GRAY, marginTop: 2 },
  resultSuccess: { color: Colors.GREEN },
  resultPending: { color: Colors.GRAY },
  resultFailed: { color: Colors.RED },
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
  // ---- Batch-wide amount control ----
  bulkAmountCard: {
    backgroundColor: Colors.GREEN,
    borderRadius: 16,
    padding: 14,
    marginBottom: Spacing.M,
  },
  bulkAmountLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: Colors.WHITE_80,
    marginBottom: 8,
  },
  bulkAmountField: {
    backgroundColor: Colors.WHITE,
    borderRadius: 12,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 50,
  },
  bulkAmountCurrency: { fontSize: 19, fontWeight: '800', color: Colors.GREEN },
  bulkAmountInput: {
    flex: 1,
    fontSize: 22,
    fontWeight: '800',
    color: Colors.DARK,
    paddingVertical: 10,
  },
  bulkAmountClear: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: Colors.LIGHT_GRAY,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bulkAmountClearText: { fontSize: 11, color: Colors.GRAY, lineHeight: 14 },
  bulkChipsRow: { flexDirection: 'row', gap: 6, marginTop: 10 },
  bulkChip: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 9,
    borderRadius: 13,
    backgroundColor: 'rgba(255,255,255,0.16)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.24)',
  },
  bulkChipSelected: { backgroundColor: Colors.WHITE, borderColor: Colors.WHITE },
  bulkChipText: { fontSize: 12, fontWeight: '800', color: Colors.WHITE },
  bulkChipTextSelected: { color: Colors.GREEN },
  bulkHintRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 9,
  },
  bulkHintText: { fontSize: 11, color: Colors.WHITE_80 },

  // ---- Recipient list ----
  listHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: Spacing.XS,
  },
  listHeaderTitle: { ...Typography.BODY, fontWeight: '700' },
  listHeaderAction: { fontSize: 12, fontWeight: '700', color: Colors.GREEN },
  recipientRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: Colors.BORDER,
  },
  recipientMain: { flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { fontSize: 14, fontWeight: '800', color: Colors.WHITE },
  recipientWho: { flex: 1, minWidth: 0 },
  recipientName: { fontSize: 14, fontWeight: '700', color: Colors.DARK },
  recipientMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3 },
  // The network is named, not just colour-coded: sending airtime to the
  // wrong carrier fails at the provider after the customer has paid, and
  // Nigerian number portability makes prefix detection unreliable.
  networkPill: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 11 },
  networkPillText: { fontSize: 10, fontWeight: '800', color: Colors.WHITE },
  networkPillTextDark: { color: Colors.DARK },
  recipientNumber: { fontSize: 12, color: Colors.GRAY, flexShrink: 1 },
  recipientAmountCol: { alignItems: 'flex-end' },
  recipientAmountInput: {
    minWidth: 78,
    borderWidth: 1.5,
    borderColor: Colors.BORDER,
    borderRadius: 10,
    paddingHorizontal: 9,
    paddingVertical: 7,
    fontSize: 13,
    fontWeight: '800',
    color: Colors.DARK,
    textAlign: 'right',
  },
  recipientAmountInputCustom: {
    borderColor: Colors.GREEN,
    color: Colors.GREEN,
    backgroundColor: Colors.GREEN_LIGHT,
  },
  recipientCustomTag: {
    fontSize: 9,
    fontWeight: '800',
    color: Colors.GREEN,
    marginTop: 3,
  },
  recipientEnd: { alignItems: 'center', justifyContent: 'center', minWidth: 18 },
  recipientRemove: { fontSize: 15, color: '#C9CFCC' },

  footerNetworkRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginBottom: Spacing.S },
  balanceAfterText: {
    fontSize: 11,
    color: Colors.GRAY,
    textAlign: 'center',
    marginTop: Spacing.XS,
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
