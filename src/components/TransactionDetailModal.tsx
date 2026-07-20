import React, { useState } from 'react';
import { View, Text, StyleSheet, Modal, TouchableOpacity, ScrollView, ActivityIndicator, Alert, Platform } from 'react-native';
import { Colors } from '../constants/colors';
import { Typography } from '../constants/typography';
import { Spacing } from '../constants/spacing';
import { formatNaira } from '../utils/formatCurrency';
import { safeErrorMessage } from '../utils/errorMessages';
import { downloadPdf, sharePdf } from '../utils/pdf';
import { buildElectricityReceiptHtml } from '../utils/receipts';
import { vtuService } from '../services/vtu.service';

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

interface PayrollRecipientEntry {
  phone: string;
  status: string;
  reason?: string;
}

function getStatusColor(status: string) {
  switch (status) {
    case 'successful':
      return Colors.SUCCESS;
    case 'pending':
      return Colors.AMBER;
    case 'failed':
      return Colors.ERROR;
    default:
      return Colors.GRAY;
  }
}

function formatFullDateTime(timestamp: string): string {
  const date = new Date(timestamp);
  const day = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const hours = date.getHours();
  const minutes = date.getMinutes().toString().padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  const formattedHours = hours % 12 || 12;
  return `${day} · ${formattedHours}:${minutes} ${ampm}`;
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
  const [generatingPdf, setGeneratingPdf] = useState(false);

  if (!transaction) return null;

  const isPayroll = transaction.rawType === 'payroll';
  const recipients: PayrollRecipientEntry[] = isPayroll && Array.isArray(transaction.metadata?.result)
    ? transaction.metadata!.result
    : [];
  const sentCount = recipients.filter((r) => r.status === 'sent').length;
  const failedRecipients = recipients.filter((r) => r.status !== 'sent');

  const failureReason = extractFailureReason(transaction.metadata);
  const allowedMetadataEntries = getAllowedMetadataEntries(transaction.metadata);

  // The token was saved into the transaction's own metadata at completion
  // time specifically so the receipt can be rebuilt here, anytime — no PDF
  // file itself is ever stored, only this short text.
  const electricityToken: string | undefined = transaction.metadata?.token;
  const electricityRequest = transaction.metadata?.request;

  const buildElectricityReceipt = () =>
    buildElectricityReceiptHtml({
      providerName: vtuService.getElectricityProviderName(String(electricityRequest?.service || '')),
      meterType: String(electricityRequest?.metertype || ''),
      meterNumber: String(electricityRequest?.meterNo || transaction.recipientPhone || ''),
      amount: transaction.amount,
      token: electricityToken || null,
      units: null,
      orderId: transaction.orderId,
      date: new Date(transaction.timestamp),
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

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          <View style={styles.handle} />

          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
            <Text style={styles.label}>{transaction.label}</Text>
            <Text style={[styles.amount, { color: transaction.direction === 'credit' ? Colors.GREEN : Colors.DARK }]}>
              {transaction.direction === 'credit' ? '+' : '-'}{formatNaira(transaction.amount)}
            </Text>

            <View style={[styles.statusBadge, { backgroundColor: getStatusColor(transaction.status) + '20' }]}>
              <Text style={[styles.statusText, { color: getStatusColor(transaction.status) }]}>
                {transaction.status.charAt(0).toUpperCase() + transaction.status.slice(1)}
              </Text>
            </View>

            <View style={styles.divider} />

            <View style={styles.row}>
              <Text style={styles.rowLabel}>Date</Text>
              <Text style={styles.rowValue}>{formatFullDateTime(transaction.timestamp)}</Text>
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
                    <ActivityIndicator color={Colors.WHITE} />
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

            {!isPayroll && failureReason && (
              <View style={styles.reasonBox}>
                <Text style={styles.reasonLabel}>Why this didn't go through</Text>
                <Text style={styles.reasonText}>{failureReason}</Text>
              </View>
            )}

            {isPayroll && recipients.length > 0 && (
              <View style={styles.payrollSection}>
                <Text style={styles.sectionTitle}>
                  Recipients ({sentCount}/{recipients.length} sent)
                </Text>
                {recipients.map((r, i) => (
                  <View key={`${r.phone}-${i}`} style={styles.recipientRow}>
                    <View style={styles.recipientLeft}>
                      <Text style={styles.recipientPhone}>{r.phone}</Text>
                      {r.status !== 'sent' && (
                        <Text style={styles.recipientReason}>{sanitizeReason(r.reason) || GENERIC_FAILURE_MESSAGE}</Text>
                      )}
                    </View>
                    <Text style={[styles.recipientStatus, { color: r.status === 'sent' ? Colors.SUCCESS : Colors.ERROR }]}>
                      {r.status === 'sent' ? '✓ Sent' : '✗ Failed'}
                    </Text>
                  </View>
                ))}
                {failedRecipients.length > 0 && (
                  <Text style={styles.payrollNote}>
                    The value of any failed recipient above was refunded to your wallet.
                  </Text>
                )}
              </View>
            )}

            {!isPayroll && allowedMetadataEntries.length > 0 && (
              <View style={styles.payrollSection}>
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

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: Colors.OVERLAY,
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: Colors.WHITE,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: Spacing.L,
    paddingTop: Spacing.S,
    paddingBottom: Spacing.XL,
    maxHeight: '85%',
  },
  handle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: Colors.BORDER,
    alignSelf: 'center',
    marginBottom: Spacing.M,
  },
  scrollContent: {
    paddingBottom: Spacing.M,
  },
  label: {
    ...Typography.SECTION_HEADING,
    color: Colors.DARK,
    textAlign: 'center',
  },
  amount: {
    ...Typography.SCREEN_TITLE,
    textAlign: 'center',
    marginTop: Spacing.S,
  },
  statusBadge: {
    alignSelf: 'center',
    borderRadius: 12,
    paddingHorizontal: Spacing.M,
    paddingVertical: 4,
    marginTop: Spacing.S,
  },
  statusText: {
    ...Typography.CAPTION,
    fontWeight: '700',
  },
  divider: {
    height: 1,
    backgroundColor: Colors.BORDER,
    marginVertical: Spacing.L,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: Spacing.S,
  },
  rowLabel: {
    ...Typography.BODY,
    color: Colors.GRAY,
  },
  rowValue: {
    ...Typography.BODY,
    color: Colors.DARK,
    fontWeight: '600',
    flexShrink: 1,
    textAlign: 'right',
    marginLeft: Spacing.M,
  },
  reasonBox: {
    backgroundColor: Colors.LIGHT_GRAY,
    borderRadius: 12,
    padding: Spacing.M,
    marginTop: Spacing.M,
  },
  receiptSection: {
    marginTop: Spacing.M,
  },
  receiptButton: {
    height: Spacing.BUTTON_HEIGHT_PRIMARY,
    backgroundColor: Colors.GREEN,
    borderRadius: Spacing.BUTTON_RADIUS,
    justifyContent: 'center',
    alignItems: 'center',
  },
  receiptButtonDisabled: { opacity: 0.5 },
  receiptButtonText: { ...Typography.BUTTON_TEXT, color: Colors.WHITE },
  receiptButtonSecondary: {
    height: Spacing.BUTTON_HEIGHT_PRIMARY,
    borderRadius: Spacing.BUTTON_RADIUS,
    borderWidth: 1,
    borderColor: Colors.GREEN,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: Spacing.S,
  },
  receiptButtonSecondaryText: { ...Typography.BUTTON_TEXT, color: Colors.GREEN },
  reasonLabel: {
    ...Typography.CAPTION,
    color: Colors.GRAY,
    marginBottom: 4,
  },
  reasonText: {
    ...Typography.BODY,
    color: Colors.DARK,
  },
  payrollSection: {
    marginTop: Spacing.L,
  },
  sectionTitle: {
    ...Typography.SECTION_HEADING,
    color: Colors.DARK,
    marginBottom: Spacing.S,
  },
  recipientRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingVertical: Spacing.S,
    borderBottomWidth: 1,
    borderBottomColor: Colors.BORDER,
  },
  recipientLeft: {
    flex: 1,
    marginRight: Spacing.M,
  },
  recipientPhone: {
    ...Typography.BODY,
    color: Colors.DARK,
    fontWeight: '600',
  },
  recipientReason: {
    ...Typography.CAPTION,
    color: Colors.GRAY,
    marginTop: 2,
  },
  recipientStatus: {
    ...Typography.CAPTION,
    fontWeight: '700',
  },
  payrollNote: {
    ...Typography.CAPTION,
    color: Colors.GRAY,
    fontStyle: 'italic',
    marginTop: Spacing.S,
  },
  closeButton: {
    height: Spacing.BUTTON_HEIGHT_PRIMARY,
    borderRadius: Spacing.BUTTON_RADIUS,
    backgroundColor: Colors.GREEN,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: Spacing.M,
  },
  closeButtonText: {
    ...Typography.BUTTON_TEXT,
    color: Colors.WHITE,
  },
});
