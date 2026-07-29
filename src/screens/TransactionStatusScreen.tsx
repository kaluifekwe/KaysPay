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
  | { kind: 'data'; phone: string; network: NetworkProvider; bundle: DataBundle; authToken: string }
  | { kind: 'electricity'; providerId: string; meterNumber: string; amount: number; type: 'prepaid' | 'postpaid'; authToken: string }
  | { kind: 'tv'; providerId: string; smartcardNumber: string; bouquetId: string; amount: number; authToken: string }
  | { kind: 'exam'; examType: ExamType; quantity: number; profileCode?: string; authToken: string };

interface Params {
  title?: string; // header label, e.g. 'Airtime'
  amount: number; // naira
  recipient?: string;
  paymentMethod?: string;
  request?: PurchaseRequest; // run on mount
  // Electricity only — data needed to (re)build the PDF receipt on success.
  electricity?: { providerName: string; meterType: string };
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

type FullResult = VTUResult & { token?: string; pins?: string[]; units?: string };

async function runRequest(req: PurchaseRequest): Promise<FullResult> {
  switch (req.kind) {
    case 'airtime':
      return vtuService.buyAirtime(req.phone, req.network, req.amount, req.authToken);
    case 'data':
      return vtuService.buyData(req.phone, req.network, req.bundle, req.authToken);
    case 'electricity':
      return vtuService.buyElectricity(req.providerId, req.meterNumber, req.amount, req.type, req.authToken);
    case 'tv':
      return vtuService.buyTVSubscription(req.providerId, req.smartcardNumber, req.bouquetId, req.amount, req.authToken);
    case 'exam':
      return vtuService.buyExamPin(req.examType, req.quantity, req.authToken, req.profileCode);
  }
}

// Result screen shown the moment Pay is tapped. It runs the purchase itself and
// shows Processing -> Successful/Failed, so there's no spinner on the Pay
// button first. A slow (VTUAfrica) order returns 'pending' and the screen polls
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
  const [generatingPdf, setGeneratingPdf] = useState(false);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedRef = useRef(Date.now());
  const ranRef = useRef(false);
  const mountedRef = useRef(true);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopPolling();
    };
  }, [stopPolling]);

  // Run the purchase once, on mount.
  useEffect(() => {
    if (!p.request || ranRef.current) return;
    ranRef.current = true;
    (async () => {
      let result: FullResult;
      try {
        result = await runRequest(p.request!);
      } catch {
        result = { success: false, error: 'Something went wrong. Please try again.' };
      }
      if (!mountedRef.current) return;
      if (result.success) {
        if (result.token) setToken(result.token);
        if (result.units) setUnits(result.units);
        if (result.order_id) setOrderId(result.order_id);
        if (result.pins && result.pins.length) setPins(result.pins);
        if (result.pending) {
          if (result.transaction_id) setTxId(result.transaction_id);
          else setNote("Your order is on the way. We'll confirm it shortly.");
        } else {
          setStatus('success');
        }
      } else {
        setStatus('failed');
        setNote(result.error || 'This did not go through. Any charge has been refunded to your wallet.');
      }
    })();
  }, [p.request]);

  // Poll the transaction while it's still processing.
  useEffect(() => {
    if (status !== 'processing' || !txId) return;
    startedRef.current = Date.now();
    pollRef.current = setInterval(async () => {
      if (Date.now() - startedRef.current > POLL_MAX_MS) {
        stopPolling();
        setNote("Still processing. We'll notify you the moment it completes.");
        return;
      }
      try {
        const { data } = await supabase
          .from('transactions')
          .select('status, metadata')
          .eq('id', txId)
          .maybeSingle();
        const s = data?.status;
        if (s === 'completed') {
          stopPolling();
          // Pull the token / exam PIN(s) / provider reference the server
          // persisted, so they show even when we only saw the settled
          // transaction (pending -> poll) rather than the purchase response.
          const m = (data?.metadata ?? {}) as { token?: string; pins?: string[]; order_id?: string };
          if (m.token) setToken(m.token);
          if (m.pins && m.pins.length) setPins(m.pins);
          if (m.order_id) setOrderId(m.order_id);
          setStatus('success');
        } else if (s === 'failed' || s === 'refunded') {
          stopPolling();
          setStatus('failed');
          setNote('This did not go through. Any charge has been refunded to your wallet.');
        }
      } catch {
        /* transient — keep polling */
      }
    }, POLL_INTERVAL_MS);
    return stopPolling;
  }, [status, txId, stopPolling]);

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
    status === 'success'
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
        <Text style={styles.amount}>{formatNaira(p.amount || 0)}</Text>

        {status === 'processing' ? (
          <View style={styles.spinnerRow}>
            <ActivityIndicator size="small" color={Colors.GRAY} />
            <Text style={styles.processingHint}>Confirming your order…</Text>
          </View>
        ) : null}

        <View style={styles.detailBlock}>
          {p.recipient ? (
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Recipient</Text>
              <Text style={styles.detailValue}>{p.recipient}</Text>
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
      </ScrollView>

      <TouchableOpacity style={styles.doneButton} onPress={goHome} activeOpacity={0.85}>
        <Text style={styles.doneText}>Done</Text>
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
