import React, { useState, useCallback, useEffect, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, ScrollView, Alert, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { Colors } from '../constants/colors';
import { formatNaira } from '../utils/formatCurrency';
import { supabase } from '../lib/supabase';
import { vtuService, type NetworkProvider, type DataBundle, type ExamType, type VTUResult } from '../services/vtu.service';
import { downloadPdf, sharePdf } from '../utils/pdf';
import { buildElectricityReceiptHtml } from '../utils/receipts';

type TxStatus = 'processing' | 'success' | 'failed';

// A serializable description of the purchase to run. Kept as plain data (no
// functions) so it survives navigation params. The screen executes it on mount
// so the user lands here IMMEDIATELY on tapping Pay — the loading happens here,
// under "Processing", instead of as a spinner on the Pay button.
export type PurchaseRequest =
  | { kind: 'airtime'; phone: string; network: NetworkProvider; amount: number; authToken: string }
  | { kind: 'data'; phone: string; network: NetworkProvider; bundle: DataBundle; authToken: string; useCashback?: boolean }
  | { kind: 'electricity'; providerId: string; meterNumber: string; amount: number; type: 'prepaid' | 'postpaid'; authToken: string; customerName?: string; customerAddress?: string; quotedTotalNaira?: number }
  | { kind: 'tv'; providerId: string; smartcardNumber: string; bouquetId: string; amount: number; authToken: string }
  | { kind: 'exam'; examType: ExamType; quantity: number; profileCode?: string; authToken: string };

interface Params {
  title?: string; // header label, e.g. 'Airtime'
  amount: number; // naira
  recipient?: string;
  paymentMethod?: string;
  request?: PurchaseRequest; // run on mount
  // Electricity only — data needed to (re)build the PDF receipt on success.
  electricity?: { providerName: string; meterType: string; customerName?: string; customerAddress?: string };
  // Fallback (not used by the request flow):
  status?: TxStatus;
  transactionId?: string;
  errorMessage?: string;
}

interface Props {
  navigation: { goBack: () => void; navigate: (s: string, p?: any) => void; popToTop?: () => void };
  route: { params: Params };
}

const SUCCESS_GREEN = '#22A45D';
const POLL_INTERVAL_MS = 1500;
const POLL_MAX_MS = 45000; // after this, reconcile + notifications take over

type FullResult = VTUResult & { token?: string; pins?: string[]; serials?: string[]; units?: string };

async function runRequest(req: PurchaseRequest, key: string): Promise<FullResult> {
  switch (req.kind) {
    case 'airtime':
      return vtuService.buyAirtime(req.phone, req.network, req.amount, req.authToken, key);
    case 'data':
      return vtuService.buyData(req.phone, req.network, req.bundle, req.authToken, key, req.useCashback);
    case 'electricity':
      return vtuService.buyElectricity(req.providerId, req.meterNumber, req.amount, req.type, req.authToken, key, req.customerName, req.customerAddress, req.quotedTotalNaira);
    case 'tv':
      return vtuService.buyTVSubscription(req.providerId, req.smartcardNumber, req.bouquetId, req.amount, req.authToken, key);
    case 'exam':
      return vtuService.buyExamPin(req.examType, req.quantity, req.authToken, req.profileCode, key);
  }
}

// Result screen shown the moment Pay is tapped. It runs the purchase itself and
// shows Processing -> Successful/Failed, so there's no spinner on the Pay
// button first. A slow provider response returns 'pending' and the screen polls
// the transaction until it settles.
export default function TransactionStatusScreen({ navigation, route }: Props) {
  const p = (route.params || {}) as Params;
  const [status, setStatus] = useState<TxStatus>(p.request ? 'processing' : p.status || 'processing');
  const [txId, setTxId] = useState<string | undefined>(p.transactionId);
  const [note, setNote] = useState('');
  const [token, setToken] = useState<string | undefined>();
  const [units, setUnits] = useState<string | undefined>();
  const [orderId, setOrderId] = useState<string | undefined>();
  const [pins, setPins] = useState<string[] | undefined>();
  const [serials, setSerials] = useState<string[] | undefined>();
  const [generatingPdf, setGeneratingPdf] = useState(false);
  const [priceChanged, setPriceChanged] = useState(false);
  const [currentAmount, setCurrentAmount] = useState<number | undefined>();
  const [cashbackEarned, setCashbackEarned] = useState<number | undefined>();

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedRef = useRef(Date.now());
  const ranRef = useRef(false);
  const mountedRef = useRef(true);
  // The idempotency key is minted HERE, before firing the purchase, so the
  // screen can watch the resulting transaction by key without waiting on the
  // purchase call's (poor-network-slow) response — see the fire-and-watch note.
  const keyRef = useRef<string>(vtuService.newRequestKey());
  // First writer of a terminal state wins — the fired purchase's response and
  // the poll race each other; whichever confirms success/failure first settles.
  const settledRef = useRef(false);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const settleSuccess = useCallback((m?: { token?: string; pins?: string[]; serials?: string[]; order_id?: string; units?: string; cashback_earned_kobo?: number }) => {
    if (settledRef.current || !mountedRef.current) return;
    settledRef.current = true;
    stopPolling();
    if (m?.token) setToken(m.token);
    if (m?.units) setUnits(m.units);
    if (m?.order_id) setOrderId(m.order_id);
    if (m?.pins && m.pins.length) setPins(m.pins);
    if (m?.serials && m.serials.length) setSerials(m.serials);
    if (m?.cashback_earned_kobo) setCashbackEarned(m.cashback_earned_kobo / 100);
    setStatus('success');
  }, [stopPolling]);

  const settleFailed = useCallback((msg?: string) => {
    if (settledRef.current || !mountedRef.current) return;
    settledRef.current = true;
    stopPolling();
    setStatus('failed');
    setNote(msg || 'This did not go through. Any charge has been refunded to your wallet.');
  }, [stopPolling]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopPolling();
    };
  }, [stopPolling]);

  // FIRE the purchase, but do NOT block the UI on its response. On a poor
  // Nigerian network, waiting on the long provider round-trip is exactly what
  // left the screen stuck on "Processing" for minutes. Instead the poll below
  // watches the transaction by our idempotency key and settles the screen the
  // moment the order lands server-side — the phone only ever makes small, quick
  // reads. We still consume THIS result for the fast-fail cases (insufficient
  // balance / re-auth / validation) that resolve before any transaction row
  // exists, which the poll alone would never see.
  useEffect(() => {
    if (!p.request || ranRef.current) return;
    ranRef.current = true;
    runRequest(p.request, keyRef.current)
      .then((result) => {
        if (!mountedRef.current || settledRef.current) return;
        if (result.success) {
          // Stash any one-time values from the response so the success screen
          // shows them even if the poll is what settles us.
          if (result.token) setToken(result.token);
          if (result.units) setUnits(result.units);
          if (result.order_id) setOrderId(result.order_id);
          if (result.pins && result.pins.length) setPins(result.pins);
          if (result.serials && result.serials.length) setSerials(result.serials);
          if (result.cashbackEarned) setCashbackEarned(result.cashbackEarned);
          if (result.transaction_id) setTxId(result.transaction_id);
          if (!result.pending) settleSuccess();
        } else {
          if (result.code === 'PLAN_DISABLED' && p.request?.kind === 'data') {
            void vtuService.refreshDataBundles(p.request.network, true);
          }
          if (result.code === 'PRICE_CHANGED') {
            setPriceChanged(true);
            setCurrentAmount(result.current_amount);
            if (p.request?.kind === 'data' && result.current_amount) {
              vtuService.applyDataPriceChange(
                p.request.network,
                p.request.bundle.id,
                result.current_amount,
              );
            }
          }
          // A definitive decline, or the request never placed an order (in
          // which case nothing was charged). Either way, safe to show failed;
          // the money layer is idempotent + reconciled regardless.
          settleFailed(result.error);
        }
      })
      .catch(() => {
        // Couldn't even get a response — that's NOT proof of failure (the order
        // may have landed). Leave it to the poll / reconcile to settle.
      });
  }, [p.request, settleSuccess, settleFailed]);

  // Watch the order settle by idempotency key — small, cheap reads that survive
  // bad networks, plus an on-demand provider verify so it flips the instant
  // VTUnaija confirms rather than waiting on the scheduled reconcile sweep.
  useEffect(() => {
    if (status !== 'processing' || !p.request) return;
    startedRef.current = Date.now();
    let verifyInFlight = false;
    let tick = 0;
    pollRef.current = setInterval(async () => {
      if (settledRef.current) {
        stopPolling();
        return;
      }
      if (Date.now() - startedRef.current > POLL_MAX_MS) {
        stopPolling();
        setNote("Still processing. We'll notify you the moment it completes.");
        return;
      }

      try {
        const { data } = await supabase
          .from('transactions')
          .select('id, status, metadata')
          .eq('metadata->>idempotency_key', keyRef.current)
          .maybeSingle();

        if (!data) return; // order not recorded yet — keep watching

        const s = data.status;
        const m = (data.metadata ?? {}) as { token?: string; pins?: string[]; serials?: string[]; order_id?: string; cashback_earned_kobo?: number };

        if (s === 'completed') {
          settleSuccess(m);
        } else if (s === 'failed' || s === 'refunded') {
          settleFailed();
        } else {
          // Still pending — roughly every 3s, ask the server to verify THIS
          // order with VTUAfrica now and settle it. Guarded so a slow verify
          // never stacks parallel calls.
          tick += 1;
          if (tick % 2 === 1 && !verifyInFlight) {
            verifyInFlight = true;
            vtuService.verifyOrder(data.id).finally(() => {
              verifyInFlight = false;
            });
          }
        }
      } catch {
        /* transient — keep watching */
      }
    }, POLL_INTERVAL_MS);
    return stopPolling;
  }, [status, p.request, settleSuccess, settleFailed, stopPolling]);

  const goHome = useCallback(() => {
    stopPolling();
    if (navigation.popToTop) navigation.popToTop();
    else navigation.navigate('HomeTabs');
  }, [navigation, stopPolling]);

  const buildReceipt = useCallback(
    () =>
      buildElectricityReceiptHtml({
        providerName: p.electricity?.providerName ?? '',
        meterType: p.electricity?.meterType ?? '',
        meterNumber: p.recipient ?? '',
        amount: p.amount ?? 0,
        token: token ?? null,
        units: units ?? null,
        orderId: orderId ?? null,
        customerName: p.electricity?.customerName ?? null,
        customerAddress: p.electricity?.customerAddress ?? null,
      }),
    [p.electricity, p.recipient, p.amount, token, units, orderId],
  );

  const onDownloadReceipt = useCallback(async () => {
    setGeneratingPdf(true);
    try {
      await downloadPdf(buildReceipt(), `Electricity_Receipt_${p.recipient ?? ''}`);
      Alert.alert(
        Platform.OS === 'android' ? 'Downloaded' : 'Saved',
        Platform.OS === 'android' ? 'Receipt saved to the folder you selected.' : 'Choose "Save to Files" to store it on your device.',
      );
    } catch {
      Alert.alert('Could not save receipt', 'Please try again.');
    } finally {
      setGeneratingPdf(false);
    }
  }, [buildReceipt, p.recipient]);

  const onShareReceipt = useCallback(async () => {
    setGeneratingPdf(true);
    try {
      await sharePdf(buildReceipt(), 'Share your electricity receipt');
    } catch {
      Alert.alert('Could not generate receipt', 'Please try again.');
    } finally {
      setGeneratingPdf(false);
    }
  }, [buildReceipt]);

  const visual =
    priceChanged
      ? { color: Colors.WARNING, icon: 'refresh' as const, label: 'Price Updated' }
      : status === 'success'
      ? { color: SUCCESS_GREEN, icon: 'checkmark' as const, label: 'Successful' }
      : status === 'failed'
      ? { color: Colors.RED, icon: 'close' as const, label: 'Failed' }
      : { color: Colors.WARNING, icon: 'time' as const, label: 'Processing' };

  const showReceipt = status === 'success' && !!p.electricity;

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={goHome} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Ionicons name="chevron-back" size={26} color={Colors.DARK} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{p.title || 'Transaction'}</Text>
        <View style={{ width: 26 }} />
      </View>

      <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
        <View style={[styles.iconCircle, { backgroundColor: visual.color }]}>
          <Ionicons name={visual.icon} size={42} color={Colors.WHITE} />
        </View>
        <Text style={styles.statusLabel}>{visual.label}</Text>
        <Text style={styles.amount}>{formatNaira(currentAmount ?? p.amount ?? 0)}</Text>

        {status === 'success' && cashbackEarned ? (
          <View style={styles.cashbackEarnedRow}>
            <Ionicons name="gift" size={16} color={Colors.AMBER} />
            <Text style={styles.cashbackEarnedText}>
              You earned {formatNaira(cashbackEarned)} cashback
            </Text>
          </View>
        ) : null}

        {status === 'processing' ? (
          <View style={styles.spinnerRow}>
            <ActivityIndicator size="small" color={Colors.GRAY} />
            <Text style={styles.processingHint}>Confirming your order…</Text>
          </View>
        ) : null}

        <View style={styles.detailBlock}>
          {p.electricity?.customerName ? (
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Customer Name</Text>
              <Text style={styles.detailValue}>{p.electricity.customerName}</Text>
            </View>
          ) : null}
          {p.recipient ? (
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Recipient</Text>
              <Text style={styles.detailValue}>{p.recipient}</Text>
            </View>
          ) : null}
          {p.electricity?.customerAddress ? (
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Address</Text>
              <Text style={[styles.detailValue, styles.tokenValue]}>{p.electricity.customerAddress}</Text>
            </View>
          ) : null}
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Payment Method</Text>
            <Text style={styles.detailValue}>{p.paymentMethod || 'Balance'}</Text>
          </View>
          {token ? (
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Token</Text>
              <Text style={[styles.detailValue, styles.tokenValue]} selectable>
                {token}
              </Text>
            </View>
          ) : null}
          {units ? (
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Units</Text>
              <Text style={styles.detailValue}>{units}</Text>
            </View>
          ) : null}
          {pins && pins.length ? (
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>{pins.length > 1 ? 'PINs' : 'PIN'}</Text>
              <Text style={[styles.detailValue, styles.tokenValue]} selectable>
                {pins.join('\n')}
              </Text>
            </View>
          ) : null}
          {serials && serials.length ? (
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>{serials.length > 1 ? 'Serials' : 'Serial'}</Text>
              <Text style={[styles.detailValue, styles.tokenValue]} selectable>
                {serials.join('\n')}
              </Text>
            </View>
          ) : null}
        </View>

        {note ? <Text style={styles.note}>{note}</Text> : null}

        {showReceipt ? (
          <View style={styles.receiptRow}>
            <TouchableOpacity
              style={[styles.receiptButton, generatingPdf && styles.receiptButtonDisabled]}
              onPress={onDownloadReceipt}
              disabled={generatingPdf}
            >
              {generatingPdf ? (
                <ActivityIndicator color={Colors.GREEN} size="small" />
              ) : (
                <Text style={styles.receiptButtonText}>Download Receipt</Text>
              )}
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.receiptButton, generatingPdf && styles.receiptButtonDisabled]}
              onPress={onShareReceipt}
              disabled={generatingPdf}
            >
              <Text style={styles.receiptButtonText}>Share Receipt</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        {!priceChanged ? (
          <TouchableOpacity
            style={styles.viewDetail}
            onPress={() => {
              stopPolling();
              navigation.navigate('TransactionHistory');
            }}
          >
            <Text style={styles.viewDetailText}>View Detail</Text>
            <Ionicons name="chevron-forward" size={16} color={Colors.PURPLE} />
          </TouchableOpacity>
        ) : null}
      </ScrollView>

      <TouchableOpacity
        style={styles.doneButton}
        onPress={priceChanged ? navigation.goBack : goHome}
        activeOpacity={0.85}
      >
        <Text style={styles.doneText}>{priceChanged ? 'Review New Price' : 'Done'}</Text>
      </TouchableOpacity>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.WHITE },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 14,
  },
  headerTitle: { fontSize: 18, fontWeight: '700', color: Colors.DARK },
  body: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24, paddingVertical: 20 },
  iconCircle: {
    width: 84,
    height: 84,
    borderRadius: 42,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
  },
  statusLabel: { fontSize: 24, fontWeight: '700', color: Colors.DARK, marginBottom: 8 },
  amount: { fontSize: 40, fontWeight: '800', color: Colors.DARK, marginBottom: 18 },
  cashbackEarnedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#FEF3C7',
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 20,
    marginTop: -8,
    marginBottom: 18,
  },
  cashbackEarnedText: { fontSize: 13, fontWeight: '700', color: '#92640A' },
  spinnerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 14 },
  processingHint: { marginLeft: 8, color: Colors.GRAY, fontSize: 14 },
  detailBlock: { width: '100%', marginTop: 8 },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: Colors.BORDER,
  },
  detailLabel: { fontSize: 15, color: Colors.GRAY },
  detailValue: { fontSize: 15, color: Colors.DARK, fontWeight: '600' },
  tokenValue: { maxWidth: '60%', textAlign: 'right' },
  note: { marginTop: 18, fontSize: 14, color: Colors.GRAY, textAlign: 'center', lineHeight: 20 },
  receiptRow: { flexDirection: 'row', gap: 12, marginTop: 22, width: '100%' },
  receiptButton: {
    flex: 1,
    borderWidth: 1.5,
    borderColor: Colors.GREEN,
    borderRadius: 12,
    paddingVertical: 13,
    alignItems: 'center',
  },
  receiptButtonDisabled: { opacity: 0.6 },
  receiptButtonText: { color: Colors.GREEN, fontSize: 15, fontWeight: '700' },
  viewDetail: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginTop: 24 },
  viewDetailText: { color: Colors.PURPLE, fontSize: 16, fontWeight: '700', marginRight: 4 },
  doneButton: {
    margin: 20,
    backgroundColor: Colors.GREEN,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
  },
  doneText: { color: Colors.WHITE, fontSize: 16, fontWeight: '700' },
});
