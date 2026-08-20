import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  Modal,
  KeyboardAvoidingView,
  Platform,
  Alert,
  ActivityIndicator,
  StyleSheet,
  Switch,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardAwareScrollView } from 'react-native-keyboard-aware-scroll-view';
import { Ionicons } from '@expo/vector-icons';
import { Colors } from '../constants/colors';
import { AppTheme } from '../constants/theme';
import { useTheme } from '../components/ThemeProvider';
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

// 9mobile is excluded everywhere else in this screen (contact picking,
// bulk-add) as currently unsupported, so it's excluded here too.
const OVERRIDABLE_NETWORKS: NgNetwork[] = ['mtn', 'airtel', 'glo'];

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
  const { theme } = useTheme();
  const styles = createStyles(theme);
  const insets = useSafeAreaInsets();

  const [airtimeRows, setAirtimeRows] = useState<AirtimeRow[]>(
    recipients.map((contact) => ({ contact, network: contact.network, amount: '', custom: false })),
  );
  // The batch-wide amount. Bulk send previously had no such control at all,
  // so "bulk" airtime meant typing the same figure once per recipient — the
  // work grew linearly with the number of people, which is the opposite of
  // what the feature is for.
  const [bulkAmount, setBulkAmount] = useState('');
  // Measured height of the pinned footer, used to pad the scroll area so the
  // last recipient can always be scrolled clear of it. This was a hardcoded
  // guess, which silently went stale the moment the footer grew (the network
  // summary and balance line pushed it past the reserved space and buried the
  // final row). It also never accounted for gesture-navigation insets, so the
  // same code looked correct on a device with hardware buttons. Measuring
  // removes both failure modes. The initial value only has to survive the
  // first frame before onLayout replaces it.
  const [footerHeight, setFooterHeight] = useState(200);
  const [dataRows, setDataRows] = useState<DataRow[]>(
    recipients.map((contact) => ({ contact, network: contact.network, bundle: null })),
  );
  const [walletBalance, setWalletBalance] = useState<number | null>(null);
  const [cashbackBalance, setCashbackBalance] = useState(0);
  // Defaults off, same reasoning as the single Data screen (2026-08-16):
  // auto-applying meant cashback never visibly accumulated.
  const [useCashback, setUseCashback] = useState(false);
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
  // Phone of the recipient whose network is being manually corrected, or
  // null. Contact-based network detection is prefix-only (see the
  // AirtimeRow/DataRow comment above) and the single-recipient Airtime/Data
  // screens already let the network guess be overridden before paying —
  // this was the one place that override wasn't possible, forcing a
  // wrong-network guess to fail at the provider and get refunded rather
  // than being caught up front.
  const [networkPickerFor, setNetworkPickerFor] = useState<string | null>(null);

  // Read the latest results inside the poll without making it a dependency
  // (which would tear down and restart the interval on every settle).
  const resultsRef = useRef(results);
  useEffect(() => {
    resultsRef.current = results;
  }, [results]);

  useEffect(() => {
    walletService.getWallet().then((res) => {
      if (res.success && res.wallet) {
        setWalletBalance(res.wallet.available_balance);
        setCashbackBalance(res.wallet.cashback_balance || 0);
      }
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

  // Corrects just the network for one recipient, keeping the same contact
  // and any amount/plan already entered — the manual-override counterpart
  // to the auto-detected `contact.network` both row types start with.
  const handleNetworkOverride = useCallback((phone: string, network: NgNetwork) => {
    setNetworkPickerFor(null);
    if (type === 'airtime') {
      setAirtimeRows((prev) => prev.map((r) => (r.contact.phone === phone ? { ...r, network } : r)));
    } else {
      setDataRows((prev) =>
        prev.map((r) => {
          if (r.contact.phone !== phone || r.network === network) return r;
          // A different network invalidates whatever plan was chosen for the
          // old one — same reasoning as handleContactSwap's network change.
          return { ...r, network, bundle: null };
        }),
      );
      if (!vtuService.hasCachedDataBundles(network)) {
        vtuService.refreshDataBundles(network);
      }
    }
  }, [type]);

  // Removing the LAST recipient used to be blocked, both here and by hiding
  // the button once one row remained. That stopped an empty batch, but it did
  // so by trapping the user: the control silently vanished with no
  // explanation and the only escape was the back button. Deleting the final
  // recipient is now allowed, and since a review screen with nobody on it has
  // nothing to review, it returns to where recipients are picked.
  const handleRemoveRecipient = useCallback((phone: string) => {
    const remaining = (type === 'airtime' ? airtimeRows : dataRows)
      .filter((r) => r.contact.phone !== phone).length;
    if (type === 'airtime') {
      setAirtimeRows((prev) => prev.filter((r) => r.contact.phone !== phone));
    } else {
      setDataRows((prev) => prev.filter((r) => r.contact.phone !== phone));
    }
    if (remaining === 0) navigation.goBack();
  }, [type, airtimeRows, dataRows, navigation]);

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

  // First recipient still without a plan, so the disabled button can name who
  // is holding the batch up. On a mixed list a grey "Send to 6 recipients"
  // gives no clue which row is unfinished.
  const firstMissingPlan = useMemo(
    () => (type === 'data' ? dataRows.find((r) => r.bundle === null) ?? null : null),
    [type, dataRows],
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

  // Preview only — the server always computes the real per-recipient split
  // from the actual stored balance, same discipline as every other amount
  // shown before payment in this app.
  const cashbackApplied = useCashback && type === 'data' ? Math.min(cashbackBalance, total) : 0;
  const walletAmountDue = total - cashbackApplied;

  const insufficientBalance = walletBalance !== null && walletAmountDue > walletBalance;

  const activePlanRow = useMemo(
    () => dataRows.find((r) => r.contact.phone === planModalFor) ?? null,
    [dataRows, planModalFor],
  );
  const activePlanBundles = useMemo(
    () => (activePlanRow ? vtuService.getDataBundles(activePlanRow.network) : []),
    [activePlanRow],
  );
  const activeNetworkRow = useMemo(() => {
    const rows: { contact: PickedContact; network: NgNetwork }[] = type === 'airtime' ? airtimeRows : dataRows;
    return rows.find((r) => r.contact.phone === networkPickerFor) ?? null;
  }, [type, airtimeRows, dataRows, networkPickerFor]);

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
        `This batch needs ${formatNaira(walletAmountDue)} from your wallet, but your available balance is ${formatNaira(walletBalance ?? 0)}.`,
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
      amount: walletAmountDue,
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
        useCashback,
      );
    }

    setPhase('done');
  }, [canSend, insufficientBalance, total, walletAmountDue, walletBalance, type, airtimeRows, dataRows, authorize, useCashback]);

  const successCount = Object.values(results).filter((r) => r.success && !r.pending).length;
  const pendingCount = Object.values(results).filter((r) => r.success && r.pending).length;
  const failedCount = Object.values(results).filter((r) => !r.success).length;

  const renderStatusIcon = (phone: string) => {
    const result = results[phone];
    // Spinner while a recipient is either still being submitted, or submitted
    // and awaiting its background settlement.
    if ((phase === 'sending' && !result) || (result?.success && result.pending)) {
      return <ActivityIndicator size="small" color={theme.inkMuted} />;
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
        <KeyboardAwareScrollView
          style={styles.scrollView}
          contentContainerStyle={[
            styles.scrollContent,
            { paddingBottom: footerHeight + Spacing.L },
          ]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          enableOnAndroid
          extraScrollHeight={20}
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

          {!locked && (
            // Nothing else on this screen signals that the network badge on
            // each row is interactive — auto-detection can guess wrong for a
            // ported number with no visual cue that anything needs checking,
            // let alone that tapping the badge is how to fix it.
            <View style={styles.networkHintRow}>
              <Text style={styles.networkHintText}>
                Auto-detected network wrong for someone? Tap their network below to correct it.
              </Text>
            </View>
          )}

          {phase !== 'review' ? (
            <View style={styles.submissionCard}>
              <View style={styles.submissionIcon}>
                {phase === 'sending' ? (
                  <ActivityIndicator size="large" color={theme.brand} />
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
                            {/* Its own tap target, separate from the
                                contact-swap area above: correcting a wrong
                                network guess shouldn't require re-picking the
                                whole person. Prefix-based detection can't
                                know about a ported number, so this is the
                                only reliable fix for it. */}
                            <TouchableOpacity
                              style={styles.networkBadge}
                              onPress={() => setNetworkPickerFor(row.contact.phone)}
                              disabled={locked}
                              hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
                              activeOpacity={0.6}
                            >
                              <ProviderLogo
                                source={NETWORK_LOGOS[row.network]}
                                fallbackLabel={NETWORK_LABEL[row.network]}
                                fallbackColor={NETWORK_COLOR[row.network]}
                                size={20}
                              />
                              <Text style={styles.networkName}>
                                {NETWORK_LABEL[row.network]}
                              </Text>
                              {!locked && <Text style={styles.networkChangeHint}>▾</Text>}
                            </TouchableOpacity>
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
                        {!locked && (
                          <TouchableOpacity
                            style={styles.removeAction}
                            onPress={() => handleRemoveRecipient(row.contact.phone)}
                            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                            activeOpacity={0.7}
                            accessibilityLabel={`Remove ${row.contact.name || row.contact.phone}`}
                          >
                            <Ionicons name="trash-outline" size={16} color={theme.down} />
                            <Text style={styles.removeActionText}>Remove</Text>
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
                const hasName = !!row.contact.name && row.contact.name !== row.contact.phone;
                const prettyPhone = formatNigerianPhone(row.contact.phone);
                return (
                  <View key={row.contact.phone} style={styles.recipientBlock}>
                    <View style={styles.recipientBlockTop}>
                      <TouchableOpacity
                        style={styles.recipientMain}
                        onPress={() => setContactPickerFor(row.contact.phone)}
                        disabled={locked}
                        activeOpacity={0.7}
                      >
                        <View
                          style={[styles.avatar, { backgroundColor: avatarColor(row.contact.phone) }]}
                        >
                          <Text style={styles.avatarText}>
                            {initialsFor(row.contact.name, row.contact.phone)}
                          </Text>
                        </View>
                        <View style={styles.recipientWho}>
                          <Text style={styles.recipientName} numberOfLines={1}>
                            {hasName ? row.contact.name : prettyPhone}
                          </Text>
                          <View style={styles.recipientMetaRow}>
                            <TouchableOpacity
                              style={styles.networkBadge}
                              onPress={() => setNetworkPickerFor(row.contact.phone)}
                              disabled={locked}
                              hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
                              activeOpacity={0.6}
                            >
                              <ProviderLogo
                                source={NETWORK_LOGOS[row.network]}
                                fallbackLabel={NETWORK_LABEL[row.network]}
                                fallbackColor={NETWORK_COLOR[row.network]}
                                size={20}
                              />
                              <Text style={styles.networkName}>{NETWORK_LABEL[row.network]}</Text>
                              {!locked && <Text style={styles.networkChangeHint}>▾</Text>}
                            </TouchableOpacity>
                            <Text style={styles.recipientNumber} numberOfLines={1}>
                              {hasName ? prettyPhone : 'Not in contacts'}
                            </Text>
                          </View>
                        </View>
                      </TouchableOpacity>
                      <View style={styles.recipientEnd}>
                        {renderStatusIcon(row.contact.phone)}
                        {!locked && (
                          <TouchableOpacity
                            style={styles.removeAction}
                            onPress={() => handleRemoveRecipient(row.contact.phone)}
                            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                            activeOpacity={0.7}
                            accessibilityLabel={`Remove ${row.contact.name || row.contact.phone}`}
                          >
                            <Ionicons name="trash-outline" size={16} color={theme.down} />
                            <Text style={styles.removeActionText}>Remove</Text>
                          </TouchableOpacity>
                        )}
                      </View>
                    </View>

                    {!bundlesReady ? (
                      <View style={styles.bundleLoadingRow}>
                        <ActivityIndicator size="small" color={theme.inkMuted} />
                        <Text style={styles.bundleLoadingText}>Loading plans…</Text>
                      </View>
                    ) : bundles.length === 0 ? (
                      <Text style={styles.bundleEmptyText}>
                        No {NETWORK_LABEL[row.network]} data plans available right now.
                      </Text>
                    ) : (
                      // Full row width on purpose: some provider plan names are
                      // long enough to embed a whole warning sentence, and a
                      // narrow control on the right would truncate them.
                      <TouchableOpacity
                        style={[styles.planSelect, row.bundle && styles.planSelectChosen]}
                        onPress={() => setPlanModalFor(row.contact.phone)}
                        disabled={locked}
                        activeOpacity={0.7}
                      >
                        {row.bundle ? (
                          <>
                            <View style={styles.planSelectMain}>
                              <Text style={styles.planSelectName} numberOfLines={1}>
                                {row.bundle.name}
                              </Text>
                              {!!row.bundle.validity && (
                                <Text style={styles.planSelectMeta} numberOfLines={1}>
                                  {row.bundle.validity}
                                </Text>
                              )}
                            </View>
                            <Text style={styles.planSelectPrice}>
                              {formatNaira(row.bundle.amount)}
                            </Text>
                          </>
                        ) : (
                          <View style={styles.planSelectMain}>
                            <Text style={styles.planSelectPlaceholder}>Select a plan</Text>
                          </View>
                        )}
                        <Text style={styles.planSelectChevron}>▾</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                );
              })}
        </KeyboardAwareScrollView>

        <View
          style={[styles.bottomContainer, { paddingBottom: insets.bottom + Spacing.SCREEN_PADDING }]}
          onLayout={(e) => setFooterHeight(e.nativeEvent.layout.height)}
        >
          {insufficientBalance && phase === 'review' && (
            <Text style={styles.insufficientText}>
              Insufficient balance for this total
            </Text>
          )}
          {phase === 'review' && networkSummary.length > 0 && (
            <View style={styles.footerNetworkRow}>
              {networkSummary.map(([network, count]) => (
                <View key={network} style={styles.footerNetworkChip}>
                  <ProviderLogo
                    source={NETWORK_LOGOS[network]}
                    fallbackLabel={NETWORK_LABEL[network]}
                    fallbackColor={NETWORK_COLOR[network]}
                    size={16}
                  />
                  <Text style={styles.footerNetworkChipText}>
                    {NETWORK_LABEL[network]} × {count}
                  </Text>
                </View>
              ))}
            </View>
          )}
          {phase === 'review' && type === 'data' && cashbackBalance > 0 && (
            <View style={styles.cashbackToggleRow}>
              <View style={styles.cashbackToggleLabel}>
                <View style={styles.cashbackToggleBadge}>
                  <Ionicons name="gift" size={18} color="#FFFFFF" />
                </View>
                <View style={styles.cashbackToggleTextCol}>
                  <Text style={styles.cashbackToggleTitle}>Use your cashback</Text>
                  <Text style={styles.cashbackToggleSubtitle}>
                    {formatNaira(cashbackBalance)} available
                    {useCashback && cashbackApplied > 0 ? (
                      <Text style={styles.cashbackToggleApplied}> • {formatNaira(cashbackApplied)} applied</Text>
                    ) : ''}
                  </Text>
                </View>
              </View>
              <Switch
                value={useCashback}
                onValueChange={setUseCashback}
                trackColor={{ false: theme.surfaceRaised, true: theme.brand }}
                thumbColor="#FFFFFF"
              />
            </View>
          )}
          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>Total</Text>
            <View style={styles.totalAmountColumn}>
              {cashbackApplied > 0 && (
                <Text style={styles.totalListValue}>{formatNaira(total)}</Text>
              )}
              <Text style={styles.totalValue}>{formatNaira(walletAmountDue)}</Text>
            </View>
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
              <Text style={styles.actionButtonText} numberOfLines={1}>
                {canSend && total > 0
                  ? `Send ${formatNaira(walletAmountDue)} to ${recipientCount} ${recipientCount === 1 ? 'person' : 'people'}`
                  : firstMissingPlan && bundlesReady
                    ? `Choose a plan for ${
                        firstMissingPlan.contact.name &&
                        firstMissingPlan.contact.name !== firstMissingPlan.contact.phone
                          ? firstMissingPlan.contact.name
                          : formatNigerianPhone(firstMissingPlan.contact.phone)
                      }`
                    : `Send to ${recipientCount} recipient${recipientCount === 1 ? '' : 's'}`}
              </Text>
            </TouchableOpacity>
          )}
          {phase === 'review' && walletBalance !== null && canSend && !insufficientBalance && (
            <Text style={styles.balanceAfterText}>
              Wallet balance {formatNaira(walletBalance)} · {formatNaira(walletBalance - walletAmountDue)} left after
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
                // Whose plan this is, spelled out with the carrier's logo. On a
                // batch of six the picker is opened repeatedly, and there was
                // otherwise nothing tying the open list back to a specific
                // number — only the contact name, which can be an emoji.
                <View style={styles.planModalSubtitleRow}>
                  <ProviderLogo
                    source={NETWORK_LOGOS[activePlanRow.network]}
                    fallbackLabel={NETWORK_LABEL[activePlanRow.network]}
                    fallbackColor={NETWORK_COLOR[activePlanRow.network]}
                    size={18}
                  />
                  <Text style={styles.planModalSubtitle} numberOfLines={1}>
                    {NETWORK_LABEL[activePlanRow.network]} ·{' '}
                    {activePlanRow.contact.name && activePlanRow.contact.name !== activePlanRow.contact.phone
                      ? `${activePlanRow.contact.name} · `
                      : ''}
                    {formatNigerianPhone(activePlanRow.contact.phone)}
                  </Text>
                </View>
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
              const hasDiscount = !!item.list_amount && item.list_amount > item.amount;
              return (
                <TouchableOpacity
                  style={[styles.planModalItem, isSelected && styles.planModalItemSelected]}
                  onPress={() => activePlanRow && handleBundleSelect(activePlanRow.contact.phone, item)}
                  activeOpacity={0.7}
                >
                  <View style={styles.flex}>
                    <Text style={styles.planModalItemName}>{item.name}</Text>
                    {!!item.validity && (
                      <Text style={styles.planModalItemMeta}>{item.validity}</Text>
                    )}
                    {restricted && (
                      <Text style={styles.planModalItemWarning}>⚠ Can fail if owing airtime</Text>
                    )}
                    {(hasDiscount || item.has_cashback) && (
                      <View style={styles.planModalBadgeRow}>
                        {hasDiscount && (
                          <View style={styles.planModalDiscountBadge}>
                            <Text style={styles.planModalDiscountBadgeText}>
                              Discount {formatNaira((item.list_amount as number) - item.amount)}
                            </Text>
                          </View>
                        )}
                        {item.has_cashback && (
                          <View style={styles.planModalCashbackBadge}>
                            <Text style={styles.planModalCashbackBadgeText}>+ Cashback</Text>
                          </View>
                        )}
                      </View>
                    )}
                  </View>
                  <View style={styles.planModalItemAmountColumn}>
                    {hasDiscount && (
                      <Text style={styles.planModalItemListPrice}>{formatNaira(item.list_amount as number)}</Text>
                    )}
                    <Text style={styles.planModalItemPrice}>{formatNaira(item.amount)}</Text>
                  </View>
                  {isSelected && <Text style={styles.planModalItemTick}>✓</Text>}
                </TouchableOpacity>
              );
            }}
          />
        </SafeAreaView>
      </Modal>

      <Modal
        visible={networkPickerFor !== null}
        animationType="slide"
        transparent
        onRequestClose={() => setNetworkPickerFor(null)}
      >
        <View style={styles.networkModalOverlay}>
          <View style={styles.networkModalSheet}>
            <View style={styles.networkModalHeader}>
              <Text style={styles.networkModalTitle}>Select Network</Text>
              <TouchableOpacity
                onPress={() => setNetworkPickerFor(null)}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <Text style={styles.planModalClose}>✕</Text>
              </TouchableOpacity>
            </View>
            {activeNetworkRow && (
              <Text style={styles.networkModalSubtitle} numberOfLines={1}>
                {activeNetworkRow.contact.name && activeNetworkRow.contact.name !== activeNetworkRow.contact.phone
                  ? `${activeNetworkRow.contact.name} · `
                  : ''}
                {formatNigerianPhone(activeNetworkRow.contact.phone)}
              </Text>
            )}
            {OVERRIDABLE_NETWORKS.map((net) => {
              const isSelected = activeNetworkRow?.network === net;
              return (
                <TouchableOpacity
                  key={net}
                  style={[styles.networkModalItem, isSelected && styles.networkModalItemSelected]}
                  onPress={() => networkPickerFor && handleNetworkOverride(networkPickerFor, net)}
                  activeOpacity={0.7}
                >
                  <ProviderLogo
                    source={NETWORK_LOGOS[net]}
                    fallbackLabel={NETWORK_LABEL[net]}
                    fallbackColor={NETWORK_COLOR[net]}
                    size={28}
                  />
                  <Text style={styles.networkModalItemText}>{NETWORK_LABEL[net]}</Text>
                  {isSelected && <Text style={styles.planModalItemTick}>✓</Text>}
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
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

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.background },
  flex: { flex: 1 },
  scrollView: { flex: 1 },
  scrollContent: {
    paddingHorizontal: Spacing.SCREEN_PADDING,
    paddingTop: Spacing.M,
    // paddingBottom is applied inline from the measured footer height — see
    // footerHeight. Deliberately not set here: a hardcoded value looks
    // authoritative while silently going stale whenever the footer changes.
  },
  backButton: {
    width: 48,
    height: 48,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: Spacing.M,
  },
  backText: { fontSize: 28, fontWeight: '600', color: theme.ink },
  title: { ...Typography.SCREEN_TITLE, color: theme.ink },
  subtitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: Spacing.L,
  },
  subtitle: {
    ...Typography.BODY,
    color: theme.inkMuted,
  },
  addMoreButton: {
    height: Spacing.CHIP_HEIGHT,
    paddingHorizontal: Spacing.M,
    borderRadius: Spacing.CHIP_HEIGHT / 2,
    borderWidth: 1,
    borderColor: theme.brand,
    justifyContent: 'center',
    alignItems: 'center',
  },
  addMoreButtonText: {
    ...Typography.CAPTION,
    color: theme.brand,
    fontWeight: '700',
  },
  bundleLoadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: Spacing.S,
  },
  bundleLoadingText: {
    ...Typography.CAPTION,
    color: theme.inkMuted,
    marginLeft: Spacing.S,
  },
  bundleEmptyText: {
    ...Typography.CAPTION,
    color: theme.inkMuted,
  },
  statusSuccess: { color: theme.brand, fontSize: 20, fontWeight: '700' },
  statusFailed: { color: theme.down, fontSize: 20, fontWeight: '700' },
  planSelectPlaceholder: { fontSize: 14, fontWeight: '600', color: theme.inkFaint },
  planSelectChevron: { fontSize: 13, color: theme.inkMuted },
  planModalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.L,
    paddingVertical: Spacing.M,
    borderBottomWidth: 1,
    borderBottomColor: theme.border,
  },
  planModalTitle: { ...Typography.SCREEN_TITLE, color: theme.ink },
  planModalSubtitle: { ...Typography.CAPTION, color: theme.inkMuted, marginTop: 2 },
  planModalClose: { fontSize: 22, color: theme.ink, paddingHorizontal: Spacing.S },
  planModalList: { paddingHorizontal: Spacing.L, paddingBottom: Spacing.XL },
  planModalSep: { height: 1, backgroundColor: theme.border },
  planModalItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: Spacing.M,
  },
  planModalItemSelected: {
    backgroundColor: theme.brandSoft,
    marginHorizontal: -Spacing.L,
    paddingHorizontal: Spacing.L,
  },
  planModalItemName: { ...Typography.BODY, color: theme.ink, flexShrink: 1 },
  planModalItemWarning: {
    ...Typography.CAPTION,
    color: theme.down,
    marginTop: 2,
  },
  planModalBadgeRow: {
    flexDirection: 'row',
    gap: 6,
    marginTop: 4,
  },
  planModalDiscountBadge: {
    backgroundColor: theme.brandSoft,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 5,
  },
  planModalDiscountBadgeText: {
    fontSize: 10,
    fontWeight: '600',
    color: theme.brand,
  },
  planModalCashbackBadge: {
    backgroundColor: '#FEF3C7',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 5,
  },
  planModalCashbackBadgeText: {
    fontSize: 10,
    fontWeight: '600',
    color: Colors.AMBER,
  },
  planModalItemAmountColumn: {
    alignItems: 'flex-end',
    marginLeft: Spacing.M,
  },
  planModalItemListPrice: {
    ...Typography.CAPTION,
    color: theme.inkMuted,
    textDecorationLine: 'line-through',
  },
  planModalItemPrice: {
    ...Typography.BODY,
    color: theme.brand,
    fontWeight: '700',
  },
  submissionCard: {
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: Spacing.CARD_RADIUS,
    padding: Spacing.XL,
    alignItems: 'center',
    backgroundColor: theme.surface,
  },
  submissionIcon: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.brandSoft,
    marginBottom: Spacing.L,
  },
  submissionCheck: { color: theme.brand, fontSize: 38, fontWeight: '700' },
  submissionTitle: {
    ...Typography.CARD_TITLE,
    color: theme.ink,
    textAlign: 'center',
    marginBottom: Spacing.S,
  },
  submissionMessage: {
    ...Typography.BODY,
    color: theme.inkMuted,
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
    borderTopColor: theme.border,
  },
  submissionProgressLabel: { ...Typography.BODY, color: theme.inkMuted },
  submissionProgressValue: { ...Typography.BODY, color: theme.ink, fontWeight: '700' },
  resultSummaryRow: {
    width: '100%',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: Spacing.L,
  },
  resultSummaryItem: { flex: 1, alignItems: 'center' },
  resultSummaryValue: { fontSize: 22, fontWeight: '700' },
  resultSummaryLabel: { ...Typography.CAPTION, color: theme.inkMuted, marginTop: 2 },
  resultSuccess: { color: theme.brand },
  resultPending: { color: theme.inkMuted },
  resultFailed: { color: theme.down },
  summaryContainer: {
    backgroundColor: theme.surfaceRaised,
    borderRadius: Spacing.CARD_RADIUS,
    padding: Spacing.CARD_PADDING,
    marginTop: Spacing.M,
  },
  summaryText: { ...Typography.BODY, color: theme.ink, textAlign: 'center' },
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
  // ---- Batch-wide amount control ----
  bulkAmountCard: {
    backgroundColor: theme.brand,
    borderRadius: 16,
    padding: 14,
    marginBottom: Spacing.M,
  },
  bulkAmountLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: 'rgba(255,255,255,0.8)',
    marginBottom: 8,
  },
  bulkAmountField: {
    backgroundColor: theme.surface,
    borderRadius: 12,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 50,
  },
  bulkAmountCurrency: { fontSize: 19, fontWeight: '800', color: theme.brand },
  bulkAmountInput: {
    flex: 1,
    fontSize: 22,
    fontWeight: '800',
    color: theme.ink,
    paddingVertical: 10,
  },
  bulkAmountClear: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: theme.surfaceRaised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bulkAmountClearText: { fontSize: 11, color: theme.inkMuted, lineHeight: 14 },
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
  bulkChipSelected: { backgroundColor: theme.surface, borderColor: theme.surface },
  // Unselected chip text sits on a translucent white fill over the fixed
  // brand-green card, so it stays literal white regardless of theme.
  bulkChipText: { fontSize: 12, fontWeight: '800', color: '#FFFFFF' },
  bulkChipTextSelected: { color: theme.brand },
  bulkHintRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 9,
  },
  bulkHintText: { fontSize: 11, color: 'rgba(255,255,255,0.8)' },

  // ---- Recipient list ----
  listHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: Spacing.XS,
  },
  listHeaderTitle: { ...Typography.BODY, color: theme.ink, fontWeight: '700' },
  listHeaderAction: { fontSize: 12, fontWeight: '700', color: theme.brand },
  recipientRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: theme.border,
  },
  recipientMain: { flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Text is always white regardless of theme — the avatar's own background
  // is one of AVATAR_COLORS, a fixed decorative palette unrelated to the
  // app theme, so white stays legible against every one of them.
  avatarText: { fontSize: 14, fontWeight: '800', color: '#FFFFFF' },
  recipientWho: { flex: 1, minWidth: 0 },
  recipientName: { fontSize: 14, fontWeight: '700', color: theme.ink },
  recipientMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3 },
  // The carrier is shown as its own logo AND named: sending airtime to the
  // wrong network fails at the provider after the customer has paid, and
  // Nigerian number portability makes prefix detection unreliable, so this
  // is worth stating twice over.
  networkBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 3,
    paddingHorizontal: 7,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.surfaceRaised,
  },
  networkName: { fontSize: 11, fontWeight: '800', color: theme.ink },
  networkChangeHint: { fontSize: 9, color: theme.inkMuted, marginLeft: 1 },
  networkHintRow: {
    backgroundColor: '#FEF3C7',
    borderRadius: 8,
    padding: Spacing.S,
    marginBottom: Spacing.M,
  },
  networkHintText: {
    ...Typography.CAPTION,
    color: '#92400E',
    fontWeight: '600',
  },
  recipientNumber: { fontSize: 12, color: theme.inkMuted, flexShrink: 1 },
  recipientAmountCol: { alignItems: 'flex-end' },
  recipientAmountInput: {
    minWidth: 78,
    borderWidth: 1.5,
    borderColor: theme.border,
    borderRadius: 10,
    paddingHorizontal: 9,
    paddingVertical: 7,
    fontSize: 13,
    fontWeight: '800',
    color: theme.ink,
    textAlign: 'right',
  },
  recipientAmountInputCustom: {
    borderColor: theme.brand,
    color: theme.brand,
    backgroundColor: theme.brandSoft,
  },
  recipientCustomTag: {
    fontSize: 9,
    fontWeight: '800',
    color: theme.brand,
    marginTop: 3,
  },
  recipientEnd: { alignItems: 'center', justifyContent: 'center' },
  // A bare ✕ read as "cancel" — and sitting beside the amount box, it could
  // be taken for "clear this amount" rather than "remove this person". A
  // trash icon with the word, in the error colour, can only mean one thing.
  removeAction: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: 2 },
  removeActionText: { fontSize: 9.5, fontWeight: '700', color: theme.down, marginTop: 1 },

  // ---- Data recipient (name/network row + its own plan control) ----
  recipientBlock: {
    paddingVertical: 11,
    borderBottomWidth: 1,
    borderBottomColor: theme.border,
  },
  recipientBlockTop: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  planSelect: {
    marginTop: 9,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1.5,
    borderColor: theme.border,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  planSelectChosen: { borderColor: theme.brand, backgroundColor: theme.brandSoft },
  planSelectMain: { flex: 1, minWidth: 0 },
  planSelectName: { fontSize: 14, fontWeight: '800', color: theme.ink },
  planSelectMeta: { fontSize: 11, color: theme.inkMuted, marginTop: 2 },
  planSelectPrice: { fontSize: 15, fontWeight: '800', color: theme.brand },

  planModalSubtitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
  planModalItemMeta: { fontSize: 11.5, color: theme.inkMuted, marginTop: 2 },
  planModalItemTick: { fontSize: 15, fontWeight: '800', color: theme.brand, marginLeft: 8 },

  networkModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'flex-end',
  },
  networkModalSheet: {
    backgroundColor: theme.surface,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: Spacing.L,
    paddingTop: Spacing.M,
    paddingBottom: Spacing.XL,
  },
  networkModalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  networkModalTitle: { ...Typography.CARD_TITLE, color: theme.ink },
  networkModalSubtitle: { ...Typography.CAPTION, color: theme.inkMuted, marginBottom: Spacing.M },
  networkModalItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: theme.border,
  },
  networkModalItemSelected: {
    backgroundColor: theme.brandSoft,
    marginHorizontal: -Spacing.L,
    paddingHorizontal: Spacing.L,
  },
  networkModalItemText: { ...Typography.BODY, color: theme.ink, fontWeight: '700', flex: 1 },

  footerNetworkRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginBottom: Spacing.S },
  footerNetworkChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: theme.surfaceRaised,
    borderRadius: 12,
    paddingLeft: 3,
    paddingRight: 8,
    paddingVertical: 2,
  },
  footerNetworkChipText: { fontSize: 10.5, fontWeight: '800', color: theme.ink },
  balanceAfterText: {
    fontSize: 11,
    color: theme.inkMuted,
    textAlign: 'center',
    marginTop: Spacing.XS,
  },

  insufficientText: {
    ...Typography.ERROR,
    marginBottom: Spacing.S,
    textAlign: 'center',
  },
  cashbackToggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#FEF3C7',
    borderWidth: 1.5,
    borderColor: 'rgba(245, 158, 11, 0.45)',
    borderRadius: 14,
    paddingHorizontal: Spacing.M,
    paddingVertical: Spacing.S + 2,
    marginBottom: Spacing.M,
    shadowColor: Colors.AMBER,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.22,
    shadowRadius: 10,
    elevation: 3,
  },
  cashbackToggleLabel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.S + 3,
    flex: 1,
  },
  cashbackToggleBadge: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: Colors.AMBER,
    justifyContent: 'center',
    alignItems: 'center',
  },
  cashbackToggleTextCol: {
    flex: 1,
  },
  cashbackToggleTitle: {
    ...Typography.CARD_TITLE,
    fontWeight: '800',
    color: '#78350F',
  },
  cashbackToggleSubtitle: {
    ...Typography.CAPTION,
    color: '#92640A',
    marginTop: 1,
  },
  cashbackToggleApplied: {
    color: theme.brand,
    fontWeight: '700',
  },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: Spacing.M,
  },
  totalLabel: { ...Typography.BODY, color: theme.inkMuted },
  totalAmountColumn: { alignItems: 'flex-end' },
  totalListValue: {
    ...Typography.CAPTION,
    color: theme.inkMuted,
    textDecorationLine: 'line-through',
  },
  totalValue: { ...Typography.AMOUNT_SMALL, color: theme.ink },
  actionButton: {
    height: Spacing.BUTTON_HEIGHT_PRIMARY,
    backgroundColor: theme.brand,
    borderRadius: Spacing.BUTTON_RADIUS,
    justifyContent: 'center',
    alignItems: 'center',
  },
  actionButtonDisabled: {
    backgroundColor: theme.inkFaint,
    opacity: 0.6,
  },
  actionButtonText: { ...Typography.BUTTON_TEXT },
  });
}
