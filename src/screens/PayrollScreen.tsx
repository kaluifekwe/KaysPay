import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  TextInput,
  Alert,
  StyleSheet,
  SafeAreaView,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { Colors } from '../constants/colors';
import { Typography } from '../constants/typography';
import { Spacing } from '../constants/spacing';

import { formatNaira } from '../utils/formatCurrency';
import { logger } from '../services/logger.service';

type ServiceType = 'airtime' | 'data';
type ScheduleType = 'now' | 'schedule';

interface Recipient {
  id: string;
  phoneNumber: string;
  amount: string;
  network: string;
}

const NETWORKS = ['MTN', 'Airtel', 'Glo', '9mobile'];

const generateId = (): string => Math.random().toString(36).substring(2, 10);

const PayrollScreen: React.FC = () => {
  const [serviceType, setServiceType] = useState<ServiceType>('airtime');
  const [scheduleType, setScheduleType] = useState<ScheduleType>('now');
  const [recipients, setRecipients] = useState<Recipient[]>([
    { id: generateId(), phoneNumber: '', amount: '', network: 'MTN' },
  ]);
  const [isProcessing, setIsProcessing] = useState(false);

  const addRecipient = useCallback(() => {
    setRecipients((prev) => [
      ...prev,
      { id: generateId(), phoneNumber: '', amount: '', network: 'MTN' },
    ]);
  }, []);

  const removeRecipient = useCallback((id: string) => {
    setRecipients((prev) => {
      if (prev.length === 1) {
        Alert.alert('Notice', 'At least one recipient is required.');
        return prev;
      }
      return prev.filter((r) => r.id !== id);
    });
  }, []);

  const updateRecipient = useCallback(
    (id: string, field: keyof Recipient, value: string) => {
      setRecipients((prev) =>
        prev.map((r) => (r.id === id ? { ...r, [field]: value } : r)),
      );
    },
    [],
  );

  const applyQuickAmount = useCallback(
    (amount: number) => {
      setRecipients((prev) =>
        prev.map((r) => ({ ...r, amount: String(amount) })),
      );
    },
    [],
  );

  const totalAmount = recipients.reduce((sum, r) => {
    const val = parseFloat(r.amount) || 0;
    return sum + val;
  }, 0);

  const validateRecipients = useCallback((): boolean => {
    for (let i = 0; i < recipients.length; i++) {
      const r = recipients[i];
      if (!r.phoneNumber || r.phoneNumber.length < 10) {
        Alert.alert(
          'Invalid Phone Number',
          `Recipient ${i + 1}: Please enter a valid phone number.`,
        );
        return false;
      }
      const amt = parseFloat(r.amount);
      if (!amt || amt <= 0) {
        Alert.alert(
          'Invalid Amount',
          `Recipient ${i + 1}: Please enter a valid amount.`,
        );
        return false;
      }
    }
    return true;
  }, [recipients]);

  const handleSend = useCallback(async () => {
    if (!validateRecipients()) return;

    setIsProcessing(true);
    try {
      console.log('Payroll send initiated', {
        serviceType,
        scheduleType,
        recipientCount: recipients.length,
        totalAmount,
      });

      // TODO: Integrate with actual VTU API
      Alert.alert(
        'Processing',
        `Your ${serviceType} request for ${recipients.length} recipient(s) is being processed.`,
      );
    } catch (error) {
      console.error('Payroll send failed', error as Error);
      Alert.alert('Error', 'Failed to process payroll. Please try again.');
    } finally {
      setIsProcessing(false);
    }
  }, [
    serviceType,
    scheduleType,
    recipients,
    totalAmount,
    validateRecipients,
  ]);

  const renderRecipient = (recipient: Recipient, index: number) => (
    <View key={recipient.id} style={styles.recipientCard}>
      <View style={styles.recipientHeader}>
        <Text style={styles.recipientIndex}>Recipient {index + 1}</Text>
        <TouchableOpacity
          onPress={() => removeRecipient(recipient.id)}
          style={styles.removeButton}
          accessibilityLabel={`Remove recipient ${index + 1}`}
        >
          <Text style={styles.removeButtonText}>Remove</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.recipientFields}>
        <View style={styles.fieldGroup}>
          <Text style={styles.fieldLabel}>Phone Number</Text>
          <TextInput
            style={styles.input}
            placeholder="e.g. 08031234567"
            placeholderTextColor={Colors.GRAY}
            keyboardType="phone-pad"
            value={recipient.phoneNumber}
            onChangeText={(text) =>
              updateRecipient(recipient.id, 'phoneNumber', text)
            }
            maxLength={11}
          />
        </View>

        <View style={styles.fieldRow}>
          <View style={[styles.fieldGroup, styles.amountField]}>
            <Text style={styles.fieldLabel}>Amount (₦)</Text>
            <TextInput
              style={styles.input}
              placeholder="0.00"
              placeholderTextColor={Colors.GRAY}
              keyboardType="numeric"
              value={recipient.amount}
              onChangeText={(text) =>
                updateRecipient(recipient.id, 'amount', text)
              }
            />
          </View>

          <View style={[styles.fieldGroup, styles.networkField]}>
            <Text style={styles.fieldLabel}>Network</Text>
            <View style={styles.networkSelector}>
              {NETWORKS.map((net) => (
                <TouchableOpacity
                  key={net}
                  style={[
                    styles.networkChip,
                    recipient.network === net && styles.networkChipActive,
                  ]}
                  onPress={() => updateRecipient(recipient.id, 'network', net)}
                >
                  <Text
                    style={[
                      styles.networkChipText,
                      recipient.network === net && styles.networkChipTextActive,
                    ]}
                  >
                    {net}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        </View>
      </View>
    </View>
  );

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView
        style={styles.keyboardAvoid}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          style={styles.container}
          contentContainerStyle={styles.contentContainer}
          keyboardShouldPersistTaps="handled"
        >
          {/* Header */}
          <View style={styles.header}>
            <TouchableOpacity
              style={styles.backButton}
              onPress={() => Alert.alert('Navigation', 'Go back')}
              accessibilityLabel="Go back"
            >
              <Text style={styles.backButtonText}>{'<'}</Text>
            </TouchableOpacity>
            <Text style={[Typography.SCREEN_TITLE, styles.screenTitle]}>
              Payroll
            </Text>
          </View>

          {/* Service Type Toggle */}
          <View style={styles.section}>
            <Text style={[Typography.SECTION_HEADING, styles.sectionTitle]}>
              Service Type
            </Text>
            <View style={styles.toggleRow}>
              <TouchableOpacity
                style={[
                  styles.toggleButton,
                  serviceType === 'airtime' && styles.toggleButtonActive,
                ]}
                onPress={() => setServiceType('airtime')}
              >
                <Text
                  style={[
                    styles.toggleButtonText,
                    serviceType === 'airtime' && styles.toggleButtonTextActive,
                  ]}
                >
                  Airtime
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.toggleButton,
                  serviceType === 'data' && styles.toggleButtonActive,
                ]}
                onPress={() => setServiceType('data')}
              >
                <Text
                  style={[
                    styles.toggleButtonText,
                    serviceType === 'data' && styles.toggleButtonTextActive,
                  ]}
                >
                  Data
                </Text>
              </TouchableOpacity>
            </View>
          </View>

          {/* Quick Amount Buttons */}
          <View style={styles.section}>
            <Text style={[Typography.SECTION_HEADING, styles.sectionTitle]}>
              Quick Amount
            </Text>
            <View style={styles.quickAmountRow}>
              {[100, 200, 500, 1000].map((amt) => (
                <TouchableOpacity
                  key={amt}
                  style={styles.quickAmountButton}
                  onPress={() => applyQuickAmount(amt)}
                >
                  <Text style={styles.quickAmountText}>
                    {formatNaira(amt)}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          {/* Recipients */}
          <View style={styles.section}>
            <View style={styles.sectionHeaderRow}>
              <Text style={[Typography.SECTION_HEADING, styles.sectionTitle]}>
                Recipients
              </Text>
              <Text style={[Typography.CAPTION, styles.recipientCount]}>
                {recipients.length} recipient(s)
              </Text>
            </View>

            {recipients.map((recipient, index) =>
              renderRecipient(recipient, index),
            )}

            <TouchableOpacity style={styles.addButton} onPress={addRecipient}>
              <Text style={styles.addButtonText}>+ Add Recipient</Text>
            </TouchableOpacity>
          </View>

          {/* Schedule */}
          <View style={styles.section}>
            <Text style={[Typography.SECTION_HEADING, styles.sectionTitle]}>
              When to Send
            </Text>
            <View style={styles.toggleRow}>
              <TouchableOpacity
                style={[
                  styles.toggleButton,
                  scheduleType === 'now' && styles.toggleButtonActive,
                ]}
                onPress={() => setScheduleType('now')}
              >
                <Text
                  style={[
                    styles.toggleButtonText,
                    scheduleType === 'now' && styles.toggleButtonTextActive,
                  ]}
                >
                  Send Now
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.toggleButton,
                  scheduleType === 'schedule' && styles.toggleButtonActive,
                ]}
                onPress={() => setScheduleType('schedule')}
              >
                <Text
                  style={[
                    styles.toggleButtonText,
                    scheduleType === 'schedule' &&
                      styles.toggleButtonTextActive,
                  ]}
                >
                  Schedule
                </Text>
              </TouchableOpacity>
            </View>
          </View>

          {/* Spacer for bottom content */}
          <View style={styles.spacer} />
        </ScrollView>

        {/* Bottom Bar */}
        <View style={styles.bottomBar}>
          <View style={styles.totalContainer}>
            <Text style={[Typography.CAPTION, styles.totalLabel]}>
              Total Amount
            </Text>
            <Text style={[Typography.AMOUNT_SMALL, styles.totalAmount]}>
              {formatNaira(totalAmount)}
            </Text>
          </View>

          <TouchableOpacity
            style={[
              styles.sendButton,
              isProcessing && styles.sendButtonDisabled,
            ]}
            onPress={handleSend}
            disabled={isProcessing}
            accessibilityLabel="Send to all recipients"
          >
            <Text style={[Typography.BUTTON_TEXT, styles.sendButtonText]}>
              {isProcessing ? 'Processing...' : 'Send to All'}
            </Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: Colors.WHITE,
  },
  keyboardAvoid: {
    flex: 1,
  },
  container: {
    flex: 1,
  },
  contentContainer: {
    padding: Spacing.SCREEN_PADDING,
    paddingBottom: Spacing.L,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: Spacing.L,
  },
  backButton: {
    width: 48,
    height: 48,
    justifyContent: 'center',
    alignItems: 'center',
  },
  backButtonText: {
    fontSize: 28,
    fontWeight: '600',
    color: Colors.DARK,
  },
  screenTitle: {
    marginLeft: Spacing.S,
    flex: 1,
  },
  section: {
    marginBottom: Spacing.L,
  },
  sectionHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  sectionTitle: {
    marginBottom: Spacing.S,
  },
  recipientCount: {
    color: Colors.GRAY,
  },
  toggleRow: {
    flexDirection: 'row',
    backgroundColor: Colors.LIGHT_GRAY,
    borderRadius: Spacing.BUTTON_RADIUS,
    padding: 3,
  },
  toggleButton: {
    flex: 1,
    paddingVertical: Spacing.S,
    alignItems: 'center',
    borderRadius: Spacing.BUTTON_RADIUS - 2,
  },
  toggleButtonActive: {
    backgroundColor: Colors.GREEN,
  },
  toggleButtonText: {
    ...Typography.BODY,
    fontWeight: '600',
    color: Colors.GRAY,
  },
  toggleButtonTextActive: {
    color: Colors.WHITE,
  },
  quickAmountRow: {
    flexDirection: 'row',
    gap: Spacing.S,
  },
  quickAmountButton: {
    flex: 1,
    backgroundColor: Colors.GREEN_LIGHT,
    paddingVertical: Spacing.S,
    alignItems: 'center',
    borderRadius: Spacing.BUTTON_RADIUS,
    borderWidth: 1,
    borderColor: Colors.GREEN_MID,
  },
  quickAmountText: {
    ...Typography.BODY,
    fontWeight: '600',
    color: Colors.GREEN_DARK,
  },
  recipientCard: {
    backgroundColor: Colors.WHITE,
    borderWidth: 1,
    borderColor: Colors.BORDER,
    borderRadius: Spacing.BUTTON_RADIUS,
    padding: Spacing.M,
    marginBottom: Spacing.S,
  },
  recipientHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: Spacing.M,
  },
  recipientIndex: {
    ...Typography.CARD_TITLE,
    color: Colors.DARK,
  },
  removeButton: {
    paddingHorizontal: Spacing.S,
    paddingVertical: Spacing.XS,
  },
  removeButtonText: {
    ...Typography.CAPTION,
    color: Colors.RED,
    fontWeight: '600',
  },
  recipientFields: {
    gap: Spacing.S,
  },
  fieldGroup: {
    marginBottom: Spacing.S,
  },
  fieldRow: {
    flexDirection: 'row',
    gap: Spacing.S,
  },
  amountField: {
    flex: 1,
  },
  networkField: {
    flex: 1,
  },
  fieldLabel: {
    ...Typography.CAPTION,
    color: Colors.GRAY,
    marginBottom: Spacing.XS,
  },
  input: {
    ...Typography.BODY,
    height: Spacing.INPUT_HEIGHT,
    borderWidth: 1,
    borderColor: Colors.BORDER,
    borderRadius: Spacing.BUTTON_RADIUS - 4,
    paddingHorizontal: Spacing.M,
    color: Colors.DARK,
    backgroundColor: Colors.WHITE,
  },
  networkSelector: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.XS,
  },
  networkChip: {
    paddingHorizontal: Spacing.S,
    paddingVertical: Spacing.XS,
    borderRadius: Spacing.BUTTON_RADIUS - 8,
    borderWidth: 1,
    borderColor: Colors.BORDER,
    backgroundColor: Colors.WHITE,
  },
  networkChipActive: {
    backgroundColor: Colors.GREEN_LIGHT,
    borderColor: Colors.GREEN_MID,
  },
  networkChipText: {
    ...Typography.CAPTION,
    color: Colors.GRAY,
    fontWeight: '500',
  },
  networkChipTextActive: {
    color: Colors.GREEN_DARK,
    fontWeight: '600',
  },
  addButton: {
    backgroundColor: Colors.GREEN_LIGHT,
    paddingVertical: Spacing.M,
    alignItems: 'center',
    borderRadius: Spacing.BUTTON_RADIUS,
    borderWidth: 1,
    borderColor: Colors.GREEN_MID,
    borderStyle: 'dashed',
  },
  addButtonText: {
    ...Typography.BODY,
    fontWeight: '600',
    color: Colors.GREEN_DARK,
  },
  spacer: {
    height: Spacing.XL,
  },
  bottomBar: {
    backgroundColor: Colors.WHITE,
    borderTopWidth: 1,
    borderTopColor: Colors.BORDER,
    paddingHorizontal: Spacing.SCREEN_PADDING,
    paddingVertical: Spacing.M,
    paddingBottom: Spacing.L,
  },
  totalContainer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: Spacing.M,
  },
  totalLabel: {
    color: Colors.GRAY,
  },
  totalAmount: {
    fontWeight: '700',
    color: Colors.GREEN_DARK,
  },
  sendButton: {
    backgroundColor: Colors.GREEN,
    height: Spacing.BUTTON_HEIGHT_PRIMARY,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: Spacing.BUTTON_RADIUS,
  },
  sendButtonDisabled: {
    opacity: 0.6,
  },
  sendButtonText: {
    color: Colors.WHITE,
    fontWeight: '700',
  },
});

export default PayrollScreen;
