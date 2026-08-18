import React, { useState } from 'react';
import { View, Text, StyleSheet, Modal, TouchableOpacity, ScrollView, ActivityIndicator, Alert, Platform, Image, Linking } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppTheme } from '../constants/theme';
import { useTheme } from './ThemeProvider';
import { Typography } from '../constants/typography';
import { Spacing } from '../constants/spacing';
import { formatNaira } from '../utils/formatCurrency';
import { formatDateTimeFull } from '../utils/formatDateTime';
import { safeErrorMessage } from '../utils/errorMessages';
import { downloadPdf, sharePdf } from '../utils/pdf';
import { buildElectricityReceiptHtml, buildExamPinReceiptHtml, buildNinCorrectionReceiptHtml, buildTransactionReceiptHtml } from '../utils/receipts';
import { vtuService } from '../services/vtu.service';
import { supabase } from '../lib/supabase';
import { withTimeout } from '../utils/network';
import {
  buildBvnSlipTraditionalHtml,
  buildBvnCardHtml,
  buildRegularSlipHtml,
  buildStandardSlipHtml,
  getEmblemBase64,
} from '../screens/NinServicesScreen';
import type { BvnRecord, NinRecord } from '../services/nin.service';

export interface TransactionDetailItem {
  id: string;
  direction: 'credit' | 'debit';
  rawType: string;
  label: string;
  recipientPhone?: string;
  network?: string;
  amount: number;
  status: 'successful' | 'pending' | 'failed' | 'refunded';
  timestamp: string;
  orderId?: string | null;
  metadata?: Record<string, any> | null;
}

function getStatusColor(theme: AppTheme, status: string) {
  switch (status) {
    case 'successful':
      return theme.up;
    case 'pending':
      return theme.gold;
    case 'failed':
      return theme.down;
    default:
      return theme.inkMuted;
  }
}

const GENERIC_FAILURE_MESSAGE =
  "This didn't go through due to a temporary issue. Any amount charged has been refunded to your wallet.";

function sanitizeReason(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'string') return undefined;
  const text = raw.trim();
  if (!text) return undefined;
  return safeErrorMessage(text, GENERIC_FAILURE_MESSAGE);
}

// Failure reasons are stored under different keys depending on which part
// of the backend wrote them (refund_service_transaction uses
// failure_reason; the withdrawal-refund path uses reason), and some
// reasons are a stringified JSON blob (nin-verify stores
// {primary, shown} to keep the real cause for diagnosis without showing it
// to the user) — dig out something readable regardless of which shape it is,
// then sanitize it so a raw technical error never reaches the screen.
function extractFailureReason(metadata: Record<string, any> | null | undefined): string | undefined {
  const raw = metadata?.failure_reason ?? metadata?.reason;
  if (!raw) return undefined;
  if (typeof raw === 'string' && raw.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(raw);
      return sanitizeReason(parsed.shown || parsed.message || parsed.primary || raw);
    } catch {
      return sanitizeReason(raw);
    }
  }
  return sanitizeReason(String(raw));
}

// VTUnaija's numeric exam_name codes (see VTUNAIJA_EXAM_IDS in
// _shared/vtu-catalog.ts, server-side) — the transaction only ever stores
// the code itself (metadata.request.exam_name), never a readable name, so
// this maps it back for display. Kept in sync with that server-side list;
// names match EXAM_PIN_TYPES' own `name` field exactly.
const EXAM_ID_NAMES: Record<string, string> = {
  '1': 'WAEC Exam PIN',
  '2': 'NECO Exam PIN',
  '3': 'NABTEB Exam PIN',
  '4': 'JAMB Exam PIN',
  '5': 'WAEC Registration PIN',
  '6': 'NBAIS Exam PIN',
};

// Only ever show a small, pre-approved, pre-labeled set of fields here —
// an ALLOWLIST, not a blocklist. A blocklist means anything new/unexpected
// (a raw provider field, a technical key, a future addition to some edge
// function's metadata) silently leaks straight to the user's screen. An
// allowlist means nothing can appear here unless it was deliberately
// reviewed and given a proper label first.
const METADATA_LABELS: Record<string, string> = {
  meter_number: 'Meter Number',
  smartcard_number: 'Smartcard Number',
  customer_id: 'Customer ID',
  customer_name: 'Customer Name',
  customer_address: 'Address',
  bank_name: 'Bank',
  account_number: 'Account Number',
  account_name: 'Account Name',
  country: 'Country',
  service_name: 'Service',
  phone_number: 'Phone Number',
  new_address: 'New Address',
  new_phone_number: 'New Phone Number',
  new_firstname: 'New First Name',
  new_surname: 'New Surname',
};

function getAllowedMetadataEntries(metadata: Record<string, any> | null | undefined): [string, string][] {
  if (!metadata) return [];
  const entries: [string, string][] = [];
  for (const [key, label] of Object.entries(METADATA_LABELS)) {
    const value = metadata[key];
    if (value === null || value === undefined || value === '') continue;
    if (typeof value !== 'string' && typeof value !== 'number') continue; // never render a raw object/array
    entries.push([label, String(value)]);
  }
  return entries;
}

export default function TransactionDetailModal({
  visible,
  transaction,
  onClose,
}: {
  visible: boolean;
  transaction: TransactionDetailItem | null;
  onClose: () => void;
}) {
  const { theme } = useTheme();
  const styles = createStyles(theme);
  const [generatingPdf, setGeneratingPdf] = useState(false);
  const insets = useSafeAreaInsets();

  if (!transaction) return null;

  const failureReason = extractFailureReason(transaction.metadata);
  const allowedMetadataEntries = getAllowedMetadataEntries(transaction.metadata);

  // The token was saved into the transaction's own metadata at completion
  // time specifically so the receipt can be rebuilt here, anytime — no PDF
  // file itself is ever stored, only this short text.
  const electricityToken: string | undefined = transaction.metadata?.token;
  const electricityRequest = transaction.metadata?.request;

  // Exam PIN(s) — and Serial(s), when the provider returns one — are
  // persisted into the transaction at completion so they can be re-read
  // here anytime — the user must be able to SEE them (to use), so they
  // render as selectable text, not just a receipt.
  const examPins: string[] | undefined = Array.isArray(transaction.metadata?.pins)
    ? (transaction.metadata?.pins as string[]).filter((x) => typeof x === 'string')
    : undefined;
  const examSerials: string[] | undefined = Array.isArray(transaction.metadata?.serials)
    ? (transaction.metadata?.serials as string[]).filter((x) => typeof x === 'string')
    : undefined;

  // The generic receipt has no field for a PIN, so a downloaded/shared exam
  // pin receipt previously showed only the amount and date — never the
  // actual PIN the customer paid for. This embeds it, same reasoning as the
  // electricity token receipt below.
  const examTypeCode = String((transaction.metadata?.request as { exam_name?: unknown } | undefined)?.exam_name ?? '');
  const examName = EXAM_ID_NAMES[examTypeCode] || transaction.label;
  const buildExamPinReceipt = () =>
    buildExamPinReceiptHtml({
      examName,
      amount: transaction.amount,
      pins: examPins!,
      serials: examSerials,
      orderId: transaction.orderId,
      date: new Date(transaction.timestamp),
    });

  const handleDownloadExamPinReceipt = async () => {
    setGeneratingPdf(true);
    try {
      await downloadPdf(buildExamPinReceipt(), `Exam_PIN_Receipt_${transaction.id}`);
      Alert.alert(
        Platform.OS === 'android' ? 'Downloaded' : 'Saved',
        Platform.OS === 'android' ? 'Receipt saved to the folder you selected.' : 'Choose "Save to Files" to store it on your device.',
      );
    } catch (e) {
      Alert.alert('Error', safeErrorMessage(e, 'Could not save the receipt. Please try again.'));
    } finally {
      setGeneratingPdf(false);
    }
  };

  const handleShareExamPinReceipt = async () => {
    setGeneratingPdf(true);
    try {
      await sharePdf(buildExamPinReceipt(), 'Share your exam PIN receipt');
    } catch (e) {
      Alert.alert('Error', safeErrorMessage(e, 'Could not generate the receipt. Please try again.'));
    } finally {
      setGeneratingPdf(false);
    }
  };

  // Re-downloadable BVN slip: a successful BVN verification stores the full
  // record in its metadata, so the slip can be rebuilt any time from History —
  // no re-verification, no charge.
  const bvnSlipRecord: BvnRecord | undefined =
    transaction.rawType === 'bvn_verification' && transaction.status === 'successful'
      ? (transaction.metadata?.record as BvnRecord | undefined)
      : undefined;
  const bvnSlipNumber = String(bvnSlipRecord?.bvn || transaction.recipientPhone || '');
  // Rebuild the SAME slip type the user paid for (regular slip vs card).
  const bvnSlipIsCard = transaction.metadata?.slip_tier === 'card';
  const buildBvnSlipHtml = async () =>
    bvnSlipIsCard
      ? buildBvnCardHtml(bvnSlipRecord!, bvnSlipNumber)
      : buildBvnSlipTraditionalHtml(bvnSlipRecord!, bvnSlipNumber, await getEmblemBase64());

  // Re-downloadable NIN slip: same rationale as the BVN slip above — a
  // successful NIN verification stores the full record in its metadata, so
  // the slip can be rebuilt any time from History, no re-verification, no charge.
  const ninSlipRecord: NinRecord | undefined =
    transaction.rawType === 'nin_verification' && transaction.status === 'successful'
      ? (transaction.metadata?.record as NinRecord | undefined)
      : undefined;
  const ninSlipNumber = String(ninSlipRecord?.nin || transaction.recipientPhone || '');
  const ninFullName = [ninSlipRecord?.firstname, ninSlipRecord?.middlename, ninSlipRecord?.surname]
    .filter(Boolean)
    .join(' ');
  // Rebuild the SAME slip type the user paid for (regular slip vs card).
  const ninSlipIsCard = transaction.metadata?.slip_tier === 'card';
  const buildNinSlipHtml = async () => {
    const emblemBase64 = await getEmblemBase64();
    return ninSlipIsCard
      ? buildStandardSlipHtml(ninSlipRecord!, ninFullName, ninSlipNumber, true, emblemBase64)
      : buildRegularSlipHtml(ninSlipRecord!, ninFullName, ninSlipNumber, emblemBase64);
  };

  // Correction Confirmation Receipt: covers all four CheckMyNINBVN order
  // types (name/phone/address modification + validation) — the provider's
  // status response never returns a corrected record (see receipts.ts), so
  // this is a receipt of the submitted request and its outcome, not a slip.
  const NIN_CORRECTION_TYPES = ['nin_name_modification', 'nin_phone_modification', 'nin_address_modification', 'nin_validation'];
  const isNinCorrection = NIN_CORRECTION_TYPES.includes(transaction.rawType);
  const buildNinCorrectionReceipt = () =>
    buildNinCorrectionReceiptHtml({
      type: transaction.rawType as any,
      referenceId: transaction.metadata?.reference_id ?? transaction.orderId ?? null,
      amount: transaction.amount,
      submittedAt: transaction.timestamp,
      status: transaction.status,
      nin: String(transaction.metadata?.nin || transaction.recipientPhone || ''),
      dateOfBirth: transaction.metadata?.date_of_birth,
      current: {
        surname: transaction.metadata?.surname,
        firstname: transaction.metadata?.firstname,
        middlename: transaction.metadata?.middlename,
        phoneNumber: transaction.metadata?.phone_number,
      },
      updated: {
        surname: transaction.metadata?.new_surname,
        firstname: transaction.metadata?.new_firstname,
        middlename: transaction.metadata?.new_middlename,
        phoneNumber: transaction.metadata?.new_phone_number,
        address: transaction.metadata?.new_address,
      },
    });

  const handleDownloadNinCorrectionReceipt = async () => {
    setGeneratingPdf(true);
    try {
      const html = buildNinCorrectionReceipt();
      await downloadPdf(html, `NIN_Correction_${transaction.metadata?.reference_id || transaction.id}`);
      Alert.alert(
        Platform.OS === 'android' ? 'Downloaded' : 'Saved',
        Platform.OS === 'android' ? 'Receipt saved to the folder you selected.' : 'Choose "Save to Files" to store it on your device.',
      );
    } catch (e) {
      Alert.alert('Error', safeErrorMessage(e, 'Could not save the receipt. Please try again.'));
    } finally {
      setGeneratingPdf(false);
    }
  };

  const handleShareNinCorrectionReceipt = async () => {
    setGeneratingPdf(true);
    try {
      const html = buildNinCorrectionReceipt();
      await sharePdf(html, 'Share your correction confirmation receipt');
    } catch (e) {
      Alert.alert('Error', safeErrorMessage(e, 'Could not generate the receipt. Please try again.'));
    } finally {
      setGeneratingPdf(false);
    }
  };

  const buildElectricityReceipt = () =>
    buildElectricityReceiptHtml({
      // provider_id/meter_type are stored top-level in metadata (same as
      // token) — NOT read from metadata.request, whose field names
      // (disco_name/MeterType/meter_number, VTUnaija's own payload shape)
      // never matched what this used to read here (service/metertype/
      // meterNo, a stale leftover from an older payload shape).
      providerName: vtuService.getElectricityProviderName(String(transaction.metadata?.provider_id || '')),
      meterType: String(electricityRequest?.MeterType || ''),
      meterNumber: String(electricityRequest?.meter_number || transaction.recipientPhone || ''),
      amount: transaction.amount,
      token: electricityToken || null,
      units: null,
      orderId: transaction.orderId,
      date: new Date(transaction.timestamp),
      customerName: transaction.metadata?.customer_name ?? null,
      customerAddress: transaction.metadata?.customer_address ?? null,
    });

  const handleDownloadReceipt = async () => {
    setGeneratingPdf(true);
    try {
      await downloadPdf(buildElectricityReceipt(), `Electricity_Receipt_${transaction.id}`);
      Alert.alert(
        Platform.OS === 'android' ? 'Downloaded' : 'Saved',
        Platform.OS === 'android' ? 'Receipt saved to the folder you selected.' : 'Choose "Save to Files" to store it on your device.',
      );
    } catch (e) {
      Alert.alert('Error', safeErrorMessage(e, 'Could not save the receipt. Please try again.'));
    } finally {
      setGeneratingPdf(false);
    }
  };

  const handleShareReceipt = async () => {
    setGeneratingPdf(true);
    try {
      await sharePdf(buildElectricityReceipt(), 'Share your electricity receipt');
    } catch (e) {
      Alert.alert('Error', safeErrorMessage(e, 'Could not generate the receipt. Please try again.'));
    } finally {
      setGeneratingPdf(false);
    }
  };

  const handleDownloadBvnSlip = async () => {
    if (!bvnSlipRecord) return;
    setGeneratingPdf(true);
    try {
      const html = await buildBvnSlipHtml();
      await downloadPdf(html, `BVN_${bvnSlipIsCard ? 'Card' : 'Slip'}_${bvnSlipNumber || transaction.id}`);
      Alert.alert(
        Platform.OS === 'android' ? 'Downloaded' : 'Saved',
        Platform.OS === 'android' ? 'Slip saved to the folder you selected.' : 'Choose "Save to Files" to store it on your device.',
      );
    } catch (e) {
      Alert.alert('Error', safeErrorMessage(e, 'Could not save the slip. Please try again.'));
    } finally {
      setGeneratingPdf(false);
    }
  };

  const handleShareBvnSlip = async () => {
    if (!bvnSlipRecord) return;
    setGeneratingPdf(true);
    try {
      const html = await buildBvnSlipHtml();
      await sharePdf(html, bvnSlipIsCard ? 'Share your BVN card' : 'Share your BVN slip');
    } catch (e) {
      Alert.alert('Error', safeErrorMessage(e, 'Could not generate the slip. Please try again.'));
    } finally {
      setGeneratingPdf(false);
    }
  };

  const handleDownloadNinSlip = async () => {
    if (!ninSlipRecord) return;
    setGeneratingPdf(true);
    try {
      const html = await buildNinSlipHtml();
      await downloadPdf(html, `NIN_${ninSlipIsCard ? 'Card' : 'Slip'}_${ninSlipNumber || transaction.id}`);
      Alert.alert(
        Platform.OS === 'android' ? 'Downloaded' : 'Saved',
        Platform.OS === 'android' ? 'Slip saved to the folder you selected.' : 'Choose "Save to Files" to store it on your device.',
      );
    } catch (e) {
      Alert.alert('Error', safeErrorMessage(e, 'Could not save the slip. Please try again.'));
    } finally {
      setGeneratingPdf(false);
    }
  };

  const handleShareNinSlip = async () => {
    if (!ninSlipRecord) return;
    setGeneratingPdf(true);
    try {
      const html = await buildNinSlipHtml();
      await sharePdf(html, ninSlipIsCard ? 'Share your NIN card' : 'Share your NIN slip');
    } catch (e) {
      Alert.alert('Error', safeErrorMessage(e, 'Could not generate the slip. Please try again.'));
    } finally {
      setGeneratingPdf(false);
    }
  };

  // The universal branded receipt (Download/Share) applies to every
  // transaction that doesn't already have its own specialized format above
  // — electricity's token receipt and the NIN/BVN slips carry one-time data
  // this generic template doesn't handle, so they keep their own flow untouched.
  const showGenericReceipt = !electricityToken && !bvnSlipRecord && !ninSlipRecord && !isNinCorrection && !(examPins && examPins.length > 0);

  const buildGenericReceipt = async () => {
    const { data: { user } } = await withTimeout(supabase.auth.getUser());
    const senderName =
      user?.user_metadata?.full_name || user?.user_metadata?.name || user?.email?.split('@')[0] || 'You';
    return buildTransactionReceiptHtml({
      label: transaction.label,
      recipient: transaction.recipientPhone ?? null,
      network: transaction.network ? transaction.network.toUpperCase() : null,
      amount: transaction.amount,
      senderName,
      timestamp: transaction.timestamp,
      reference: transaction.orderId,
      status: transaction.status,
    });
  };

  const handleDownloadGenericReceipt = async () => {
    setGeneratingPdf(true);
    try {
      const html = await buildGenericReceipt();
      await downloadPdf(html, `Receipt_${transaction.id}`);
      Alert.alert(
        Platform.OS === 'android' ? 'Downloaded' : 'Saved',
        Platform.OS === 'android' ? 'Receipt saved to the folder you selected.' : 'Choose "Save to Files" to store it on your device.',
      );
    } catch (e) {
      Alert.alert('Error', safeErrorMessage(e, 'Could not save the receipt. Please try again.'));
    } finally {
      setGeneratingPdf(false);
    }
  };

  const handleShareGenericReceipt = async () => {
    setGeneratingPdf(true);
    try {
      const html = await buildGenericReceipt();
      await sharePdf(html, 'Share your receipt');
    } catch (e) {
      Alert.alert('Error', safeErrorMessage(e, 'Could not generate the receipt. Please try again.'));
    } finally {
      setGeneratingPdf(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={[styles.sheet, { paddingBottom: insets.bottom + Spacing.M }]}>
          <View style={styles.brandHeader}>
            <View style={styles.handle} />
            <View style={styles.brandRow}>
              <Image source={require('../../assets/icon-green.png')} style={styles.brandLogo} resizeMode="contain" />
              <Text style={styles.brandName}>Kay's Pay</Text>
            </View>
            <Text style={styles.label}>{transaction.label}</Text>
            <Text style={styles.amount}>
              {transaction.direction === 'credit' ? '+' : '-'}{formatNaira(transaction.amount)}
            </Text>
          </View>

          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
            <View style={styles.row}>
              <Text style={styles.rowLabel}>Status</Text>
              <View style={[styles.statusBadge, { backgroundColor: getStatusColor(theme, transaction.status) + '20' }]}>
                <Text style={[styles.statusText, { color: getStatusColor(theme, transaction.status) }]}>
                  {transaction.status.charAt(0).toUpperCase() + transaction.status.slice(1)}
                </Text>
              </View>
            </View>

            <View style={styles.row}>
              <Text style={styles.rowLabel}>Date</Text>
              <Text style={styles.rowValue}>{formatDateTimeFull(transaction.timestamp)}</Text>
            </View>

            {transaction.recipientPhone && (
              <View style={styles.row}>
                <Text style={styles.rowLabel}>Recipient</Text>
                <Text style={styles.rowValue}>{transaction.recipientPhone}</Text>
              </View>
            )}

            {transaction.network && (
              <View style={styles.row}>
                <Text style={styles.rowLabel}>Network</Text>
                <Text style={styles.rowValue}>{transaction.network.toUpperCase()}</Text>
              </View>
            )}

            {transaction.orderId && (
              <View style={styles.row}>
                <Text style={styles.rowLabel}>Reference</Text>
                <Text style={styles.rowValue}>{transaction.orderId}</Text>
              </View>
            )}

            {electricityToken && (
              <View style={styles.receiptSection}>
                <TouchableOpacity
                  style={[styles.receiptButton, generatingPdf && styles.receiptButtonDisabled]}
                  onPress={handleDownloadReceipt}
                  disabled={generatingPdf}
                >
                  {generatingPdf ? (
                    <ActivityIndicator color="#FFFFFF" />
                  ) : (
                    <Text style={styles.receiptButtonText}>Download Receipt (PDF)</Text>
                  )}
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.receiptButtonSecondary, generatingPdf && styles.receiptButtonDisabled]}
                  onPress={handleShareReceipt}
                  disabled={generatingPdf}
                >
                  <Text style={styles.receiptButtonSecondaryText}>Share Receipt</Text>
                </TouchableOpacity>
              </View>
            )}

            {showGenericReceipt && (
              <View style={styles.receiptSection}>
                <TouchableOpacity
                  style={[styles.receiptButton, generatingPdf && styles.receiptButtonDisabled]}
                  onPress={handleDownloadGenericReceipt}
                  disabled={generatingPdf}
                >
                  {generatingPdf ? (
                    <ActivityIndicator color="#FFFFFF" />
                  ) : (
                    <Text style={styles.receiptButtonText}>Download Receipt (PDF)</Text>
                  )}
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.receiptButtonSecondary, generatingPdf && styles.receiptButtonDisabled]}
                  onPress={handleShareGenericReceipt}
                  disabled={generatingPdf}
                >
                  <Text style={styles.receiptButtonSecondaryText}>Share Receipt</Text>
                </TouchableOpacity>
              </View>
            )}

            {examPins && examPins.length > 0 && (
              <View style={styles.receiptSection}>
                <Text style={styles.sectionTitle}>{examPins.length > 1 ? 'Your PINs' : 'Your PIN'}</Text>
                <Text style={styles.pinValue} selectable>{examPins.join('\n')}</Text>
              </View>
            )}

            {examSerials && examSerials.length > 0 && (
              <View style={styles.receiptSection}>
                <Text style={styles.sectionTitle}>{examSerials.length > 1 ? 'Your Serials' : 'Your Serial'}</Text>
                <Text style={styles.pinValue} selectable>{examSerials.join('\n')}</Text>
              </View>
            )}

            {examPins && examPins.length > 0 && (
              <View style={styles.receiptSection}>
                <TouchableOpacity
                  style={[styles.receiptButton, generatingPdf && styles.receiptButtonDisabled]}
                  onPress={handleDownloadExamPinReceipt}
                  disabled={generatingPdf}
                >
                  {generatingPdf ? (
                    <ActivityIndicator color="#FFFFFF" />
                  ) : (
                    <Text style={styles.receiptButtonText}>Download Receipt (PDF)</Text>
                  )}
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.receiptButtonSecondary, generatingPdf && styles.receiptButtonDisabled]}
                  onPress={handleShareExamPinReceipt}
                  disabled={generatingPdf}
                >
                  <Text style={styles.receiptButtonSecondaryText}>Share Receipt</Text>
                </TouchableOpacity>
              </View>
            )}

            {bvnSlipRecord && (
              <View style={styles.receiptSection}>
                <Text style={styles.sectionTitle}>BVN Slip</Text>
                <TouchableOpacity
                  style={[styles.receiptButton, generatingPdf && styles.receiptButtonDisabled]}
                  onPress={handleDownloadBvnSlip}
                  disabled={generatingPdf}
                >
                  {generatingPdf ? (
                    <ActivityIndicator color="#FFFFFF" />
                  ) : (
                    <Text style={styles.receiptButtonText}>Download BVN Slip (PDF)</Text>
                  )}
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.receiptButtonSecondary, generatingPdf && styles.receiptButtonDisabled]}
                  onPress={handleShareBvnSlip}
                  disabled={generatingPdf}
                >
                  <Text style={styles.receiptButtonSecondaryText}>Share BVN Slip</Text>
                </TouchableOpacity>
              </View>
            )}

            {ninSlipRecord && (
              <View style={styles.receiptSection}>
                <Text style={styles.sectionTitle}>NIN Slip</Text>
                <TouchableOpacity
                  style={[styles.receiptButton, generatingPdf && styles.receiptButtonDisabled]}
                  onPress={handleDownloadNinSlip}
                  disabled={generatingPdf}
                >
                  {generatingPdf ? (
                    <ActivityIndicator color="#FFFFFF" />
                  ) : (
                    <Text style={styles.receiptButtonText}>Download NIN Slip (PDF)</Text>
                  )}
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.receiptButtonSecondary, generatingPdf && styles.receiptButtonDisabled]}
                  onPress={handleShareNinSlip}
                  disabled={generatingPdf}
                >
                  <Text style={styles.receiptButtonSecondaryText}>Share NIN Slip</Text>
                </TouchableOpacity>
              </View>
            )}

            {isNinCorrection && (
              <View style={styles.receiptSection}>
                <Text style={styles.sectionTitle}>Correction Confirmation Receipt</Text>
                <TouchableOpacity
                  style={[styles.receiptButton, generatingPdf && styles.receiptButtonDisabled]}
                  onPress={handleDownloadNinCorrectionReceipt}
                  disabled={generatingPdf}
                >
                  {generatingPdf ? (
                    <ActivityIndicator color="#FFFFFF" />
                  ) : (
                    <Text style={styles.receiptButtonText}>Download Receipt (PDF)</Text>
                  )}
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.receiptButtonSecondary, generatingPdf && styles.receiptButtonDisabled]}
                  onPress={handleShareNinCorrectionReceipt}
                  disabled={generatingPdf}
                >
                  <Text style={styles.receiptButtonSecondaryText}>Share Receipt</Text>
                </TouchableOpacity>
              </View>
            )}

            {transaction.rawType === 'esim' && transaction.metadata?.qrcode_url && (
              <View style={styles.esimSection}>
                <Text style={styles.sectionTitle}>Your eSIM</Text>
                <View style={styles.qrWrap}>
                  <Image
                    source={{ uri: transaction.metadata.qrcode_url }}
                    style={styles.qrImage}
                    resizeMode="contain"
                  />
                </View>
                {transaction.metadata?.iccid && (
                  <View style={styles.row}>
                    <Text style={styles.rowLabel}>ICCID</Text>
                    <Text style={styles.rowValue}>{transaction.metadata.iccid}</Text>
                  </View>
                )}
                <Text style={styles.esimHint}>
                  Scan this QR on the phone you want the eSIM on: Settings → Cellular / Mobile → Add eSIM. You can reopen it here anytime.
                </Text>
                {Platform.OS === 'ios' && !!transaction.metadata?.apple_install_url && (
                  <TouchableOpacity
                    style={styles.receiptButton}
                    onPress={() => Linking.openURL(String(transaction.metadata!.apple_install_url))}
                  >
                    <Text style={styles.receiptButtonText}>Install on this iPhone</Text>
                  </TouchableOpacity>
                )}
              </View>
            )}

            {failureReason && (
              <View style={styles.reasonBox}>
                <Text style={styles.reasonLabel}>Why this didn't go through</Text>
                <Text style={styles.reasonText}>{failureReason}</Text>
              </View>
            )}

            {allowedMetadataEntries.length > 0 && (
              <View style={styles.detailSection}>
                <Text style={styles.sectionTitle}>Details</Text>
                {allowedMetadataEntries.map(([label, value]) => (
                  <View key={label} style={styles.row}>
                    <Text style={styles.rowLabel}>{label}</Text>
                    <Text style={styles.rowValue}>{value}</Text>
                  </View>
                ))}
              </View>
            )}
          </ScrollView>

          <TouchableOpacity style={styles.closeButton} onPress={onClose} activeOpacity={0.7}>
            <Text style={styles.closeButtonText}>Close</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: theme.surface,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    overflow: 'hidden',
    maxHeight: '88%',
  },
  // The branded header — same look as the shared Download/Share receipt
  // (utils/receipts.ts's buildTransactionReceiptHtml), so what you see the
  // moment you open a transaction already matches what gets shared/saved,
  // not just the exported PDF.
  brandHeader: {
    backgroundColor: '#123626',
    paddingTop: Spacing.S,
    paddingBottom: Spacing.L,
    paddingHorizontal: Spacing.L,
  },
  handle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.3)',
    alignSelf: 'center',
    marginBottom: Spacing.M,
  },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.S,
    marginBottom: Spacing.L,
  },
  brandLogo: {
    width: 24,
    height: 24,
    borderRadius: 6,
  },
  brandName: {
    ...Typography.BODY,
    fontWeight: '800',
    color: '#FFFFFF',
  },
  scrollContent: {
    paddingHorizontal: Spacing.L,
    paddingTop: Spacing.L,
    paddingBottom: Spacing.M,
  },
  label: {
    ...Typography.SECTION_HEADING,
    color: '#FFFFFF',
    textAlign: 'center',
    opacity: 0.85,
  },
  amount: {
    ...Typography.SCREEN_TITLE,
    color: '#FFFFFF',
    textAlign: 'center',
    marginTop: Spacing.S,
  },
  statusBadge: {
    borderRadius: 12,
    paddingHorizontal: Spacing.M,
    paddingVertical: 4,
  },
  statusText: {
    ...Typography.CAPTION,
    fontWeight: '700',
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: Spacing.S,
  },
  rowLabel: {
    ...Typography.BODY,
    color: theme.inkMuted,
  },
  rowValue: {
    ...Typography.BODY,
    color: theme.ink,
    fontWeight: '600',
    flexShrink: 1,
    textAlign: 'right',
    marginLeft: Spacing.M,
  },
  reasonBox: {
    backgroundColor: theme.surfaceRaised,
    borderRadius: 12,
    padding: Spacing.M,
    marginTop: Spacing.M,
  },
  receiptSection: {
    marginTop: Spacing.M,
  },
  receiptButton: {
    height: Spacing.BUTTON_HEIGHT_PRIMARY,
    backgroundColor: theme.brand,
    borderRadius: Spacing.BUTTON_RADIUS,
    justifyContent: 'center',
    alignItems: 'center',
  },
  receiptButtonDisabled: { opacity: 0.5 },
  receiptButtonText: { ...Typography.BUTTON_TEXT, color: '#FFFFFF' },
  receiptButtonSecondary: {
    height: Spacing.BUTTON_HEIGHT_PRIMARY,
    borderRadius: Spacing.BUTTON_RADIUS,
    borderWidth: 1,
    borderColor: theme.brand,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: Spacing.S,
  },
  receiptButtonSecondaryText: { ...Typography.BUTTON_TEXT, color: theme.brand },
  reasonLabel: {
    ...Typography.CAPTION,
    color: theme.inkMuted,
    marginBottom: 4,
  },
  reasonText: {
    ...Typography.BODY,
    color: theme.ink,
  },
  detailSection: {
    marginTop: Spacing.L,
  },
  esimSection: {
    marginTop: Spacing.L,
  },
  qrWrap: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    paddingVertical: Spacing.M,
    marginBottom: Spacing.S,
  },
  qrImage: {
    width: 220,
    height: 220,
  },
  esimHint: {
    ...Typography.CAPTION,
    color: theme.inkMuted,
    marginTop: Spacing.S,
    marginBottom: Spacing.M,
  },
  sectionTitle: {
    ...Typography.SECTION_HEADING,
    color: theme.ink,
    marginBottom: Spacing.S,
  },
  pinValue: {
    fontSize: 18,
    fontWeight: '700',
    color: theme.ink,
    letterSpacing: 1,
    lineHeight: 28,
  },
  closeButton: {
    height: Spacing.BUTTON_HEIGHT_PRIMARY,
    borderRadius: Spacing.BUTTON_RADIUS,
    backgroundColor: theme.brand,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: Spacing.M,
  },
  closeButtonText: {
    ...Typography.BUTTON_TEXT,
    color: '#FFFFFF',
  },
  });
}
