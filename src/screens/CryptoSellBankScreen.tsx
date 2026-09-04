import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  Modal,
  FlatList,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { Typography } from '../constants/typography';
import { Spacing } from '../constants/spacing';
import { AppTheme } from '../constants/theme';
import { useTheme } from '../components/ThemeProvider';
import { formatNaira } from '../utils/formatCurrency';
import { cryptoService, type CryptoSellQuote } from '../services/crypto.service';
import { useTransactionAuth } from '../components/TransactionAuthProvider';
import BankLogoIcon from '../components/BankLogoIcon';
import ResultStatusView, { type ResultStatus } from '../components/ResultStatusView';

function formatUsdt(n: number): string {
  const floored = Math.floor((Number.isFinite(n) ? n : 0) * 100) / 100;
  return `${floored.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT`;
}

/**
 * Step 2 of Sell — bank details and confirmation, on its own screen so
 * amount entry (step 1, on CryptoScreen) isn't crowded by a form the
 * customer hasn't earned yet. Same pattern TV/Electricity already use:
 * pick what you're paying for, THEN a fresh screen asks for the account.
 */
export default function CryptoSellBankScreen({ navigation, route }: any) {
  const { sellUsdt, sellQuote } = route.params as { sellUsdt: number; sellQuote: CryptoSellQuote };
  const { authorize } = useTransactionAuth();
  const { theme } = useTheme();
  const styles = createStyles(theme);

  const [sellBanks, setSellBanks] = useState<{ code: string; name: string; logo?: string }[]>([]);
  const [sellBanksLoading, setSellBanksLoading] = useState(true);
  const [sellBankPickerVisible, setSellBankPickerVisible] = useState(false);
  const [sellBankSearch, setSellBankSearch] = useState('');
  const [sellBank, setSellBank] = useState<{ code: string; name: string; logo?: string } | null>(null);
  const [sellAccountNumber, setSellAccountNumber] = useState('');
  const [sellVerifyState, setSellVerifyState] = useState<'idle' | 'checking' | 'verified' | 'failed'>('idle');
  const [sellVerifiedName, setSellVerifiedName] = useState<string | null>(null);
  const [sellVerifyError, setSellVerifyError] = useState<string | null>(null);

  const [actionState, setActionState] = useState<ResultStatus | 'idle'>('idle');
  const [actionError, setActionError] = useState('');
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    cryptoService.listSellBanks().then((list) => {
      setSellBanksLoading(false);
      setSellBanks(list);
    });
  }, []);

  // Resets whenever bank/account changes — a verified checkmark must never
  // survive an edit to the account it was verified against.
  useEffect(() => {
    setSellVerifyState('idle');
    setSellVerifiedName(null);
    setSellVerifyError(null);
  }, [sellBank, sellAccountNumber]);

  useEffect(() => {
    if (!sellBank || sellAccountNumber.length !== 10) return;
    const handle = setTimeout(async () => {
      setSellVerifyState('checking');
      const res = await cryptoService.resolveSellAccount(sellUsdt, sellBank.code, sellAccountNumber);
      setSellVerifyState((current) => {
        if (current !== 'checking') return current;
        return res.success ? 'verified' : 'failed';
      });
      if (res.success) {
        setSellVerifiedName(res.accountName || null);
      } else {
        setSellVerifyError(res.error || 'Could not verify this account.');
      }
    }, 700);
    return () => clearTimeout(handle);
  }, [sellBank, sellAccountNumber, sellUsdt]);

  const sellAccountNumberValid = /^\d{10}$/.test(sellAccountNumber);
  const canSell = !!sellBank && sellAccountNumberValid && sellVerifyState === 'verified';
  const sellNgnEstimate = sellQuote.expectedNgn;

  const handleSell = useCallback(async () => {
    if (!canSell || !sellBank || sending) return;
    // Disabled BEFORE the PIN/biometric step, not after it -- same fix as
    // CryptoScreen's handleBuy (see its comment): authorize() awaits real
    // user interaction, so leaving the button live until it resolves let a
    // second tap start an entirely separate sale, observed live as two real
    // off-ramp orders ~73 seconds apart for the same amount.
    setSending(true);
    const authResult = await authorize({
      title: 'Confirm Crypto Sale',
      amount: sellNgnEstimate ?? undefined,
      subtitle: `${sellBank.name} · ${sellAccountNumber}`,
      // Sell pays the customer's bank account directly from Quidax's own
      // liquidity -- it never touches the KaysPay wallet -- and
      // sellNgnEstimate is proceeds the user is about to RECEIVE, not an
      // amount spent from the wallet, so a wallet-balance check is backwards.
      skipBalanceCheck: true,
    });
    if (!authResult) {
      setSending(false);
      return;
    }
    setActionState('processing');
    const result = await cryptoService.sell(sellUsdt, sellBank.code, sellBank.name, sellAccountNumber, authResult.token);
    setSending(false);
    if (result.success) {
      setActionMessage(result.message ?? null);
      setActionState('success');
    } else {
      setActionError(result.error || 'Sale failed. Please try again.');
      setActionState('failed');
    }
  }, [canSell, sellBank, sellAccountNumber, sellNgnEstimate, sellUsdt, authorize, sending]);

  if (actionState !== 'idle') {
    return (
      <ResultStatusView
        status={actionState}
        headerTitle="Sell to Bank"
        amount={sellNgnEstimate ?? undefined}
        message={actionState === 'failed' ? actionError : actionMessage ?? undefined}
        onDone={() => {
          if (actionState === 'success') {
            navigation.navigate('HomeTabs');
          } else {
            setActionState('idle');
          }
        }}
      />
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={navigation.goBack} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Ionicons name="chevron-back" size={24} color={theme.ink} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Sell to Bank</Text>
        <View style={{ width: 24 }} />
      </View>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.content}>
          <View style={styles.recapCard}>
            <View style={styles.recapRow}>
              <Text style={styles.recapLabel}>Selling</Text>
              <Text style={styles.recapValueStrong}>{formatUsdt(sellQuote.amount)}</Text>
            </View>
            <View style={styles.recapRow}>
              <Text style={styles.recapLabel}>{sellQuote.network.toUpperCase()} network fee</Text>
              <Text style={styles.recapValue}>{formatUsdt(sellQuote.networkFee)}</Text>
            </View>
            {sellNgnEstimate != null && (
              <View style={styles.recapRow}>
                <Text style={styles.recapLabel}>You receive</Text>
                <Text style={styles.recapValueReceive}>{formatNaira(sellNgnEstimate)}</Text>
              </View>
            )}
          </View>

          <Text style={styles.label}>Bank</Text>
          <TouchableOpacity
            style={styles.bankSelect}
            onPress={() => setSellBankPickerVisible(true)}
            activeOpacity={0.7}
            disabled={sellBanksLoading}
          >
            {sellBanksLoading ? (
              <ActivityIndicator size="small" color={theme.inkMuted} />
            ) : (
              <View style={styles.bankSelectRow}>
                {sellBank && <BankLogoIcon bank={sellBank} size={22} />}
                <Text style={sellBank ? styles.bankSelectText : styles.bankSelectPlaceholder}>
                  {sellBank ? sellBank.name : 'Choose a bank'}
                </Text>
              </View>
            )}
          </TouchableOpacity>

          <Text style={styles.label}>Account Number</Text>
          <TextInput
            style={styles.input}
            value={sellAccountNumber}
            onChangeText={(t) => setSellAccountNumber(t.replace(/[^0-9]/g, '').slice(0, 10))}
            placeholder="10-digit account number"
            placeholderTextColor={theme.inkFaint}
            keyboardType="number-pad"
            maxLength={10}
          />
          {sellVerifyState === 'checking' && (
            <View style={styles.verifyRow}>
              <ActivityIndicator size="small" color={theme.inkMuted} />
              <Text style={styles.verifyCheckingText}>Verifying account…</Text>
            </View>
          )}
          {sellVerifyState === 'verified' && sellVerifiedName && (
            <View style={styles.verifiedCard}>
              <View style={styles.verifiedHeading}>
                <View style={styles.verifiedIcon}>
                  <Ionicons name="checkmark" size={14} color="#FFFFFF" />
                </View>
                <Text style={styles.verifiedTitle}>Account verified</Text>
              </View>
              <Text style={styles.verifiedName}>{sellVerifiedName}</Text>
            </View>
          )}
          {sellVerifyState === 'failed' && (
            <Text style={styles.errorText}>{sellVerifyError || 'Could not verify this account.'}</Text>
          )}
          {sellVerifyState === 'idle' && (
            <Text style={styles.hintText}>Must be an account in your own name.</Text>
          )}

          <View style={{ flex: 1 }} />
          <TouchableOpacity
            style={[styles.primaryButton, (!canSell || sending) && styles.primaryButtonDisabled]}
            onPress={handleSell}
            disabled={!canSell || sending}
          >
            {sending ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.primaryButtonText}>Confirm Sell</Text>}
          </TouchableOpacity>
          <Text style={styles.hintText}>Paid straight to that bank account — your KaysPay wallet is not involved.</Text>
        </View>
      </KeyboardAvoidingView>

      <Modal visible={sellBankPickerVisible} animationType="slide" onRequestClose={() => setSellBankPickerVisible(false)}>
        <SafeAreaView style={styles.container}>
          <View style={styles.header}>
            <Text style={styles.headerTitle}>Select Bank</Text>
            <TouchableOpacity onPress={() => setSellBankPickerVisible(false)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name="close" size={22} color={theme.ink} />
            </TouchableOpacity>
          </View>
          <TextInput
            style={styles.pickerSearch}
            value={sellBankSearch}
            onChangeText={setSellBankSearch}
            placeholder="Search bank..."
            placeholderTextColor={theme.inkMuted}
            autoFocus
          />
          <FlatList
            data={sellBanks.filter((b) => b.name.toLowerCase().includes(sellBankSearch.trim().toLowerCase()))}
            keyExtractor={(b) => b.code}
            renderItem={({ item }) => (
              <TouchableOpacity
                style={[styles.pickerRow, styles.pickerRowWithLogo]}
                activeOpacity={0.7}
                onPress={() => {
                  setSellBank(item);
                  setSellBankPickerVisible(false);
                  setSellBankSearch('');
                }}
              >
                <BankLogoIcon bank={item} size={28} />
                <Text style={styles.pickerRowText}>{item.name}</Text>
              </TouchableOpacity>
            )}
            ListEmptyComponent={<Text style={styles.pickerEmptyText}>No matching bank.</Text>}
            keyboardShouldPersistTaps="handled"
          />
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.background },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: Spacing.SCREEN_PADDING,
      paddingVertical: Spacing.M,
      borderBottomWidth: 1,
      borderBottomColor: theme.hairline,
    },
    headerTitle: { ...Typography.SECTION_HEADING, color: theme.ink },
    content: { flex: 1, paddingHorizontal: Spacing.SCREEN_PADDING, paddingTop: Spacing.L },

    recapCard: {
      padding: Spacing.L,
      borderRadius: Spacing.CARD_RADIUS,
      backgroundColor: theme.surfaceRaised,
      marginBottom: Spacing.M,
    },
    recapRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
    recapLabel: { ...Typography.CAPTION, color: theme.inkMuted },
    recapValue: { ...Typography.BODY, color: theme.ink, fontWeight: '600' },
    recapValueStrong: { ...Typography.BODY, color: theme.ink, fontWeight: '700' },
    recapValueReceive: { ...Typography.BODY, color: theme.brand, fontWeight: '700' },

    label: { ...Typography.SECTION_HEADING, color: theme.ink, marginTop: Spacing.M, marginBottom: Spacing.M },
    input: {
      height: Spacing.INPUT_HEIGHT,
      borderWidth: Spacing.INPUT_BORDER_WIDTH,
      borderColor: theme.hairline,
      backgroundColor: theme.surfaceRaised,
      borderRadius: Spacing.BUTTON_RADIUS,
      paddingHorizontal: Spacing.L,
      ...Typography.BODY,
      color: theme.ink,
    },
    bankSelect: {
      height: Spacing.INPUT_HEIGHT,
      borderWidth: Spacing.INPUT_BORDER_WIDTH,
      borderColor: theme.hairline,
      backgroundColor: theme.surfaceRaised,
      borderRadius: Spacing.BUTTON_RADIUS,
      paddingHorizontal: Spacing.L,
      justifyContent: 'center',
    },
    bankSelectRow: { flexDirection: 'row', alignItems: 'center' },
    bankSelectText: { ...Typography.BODY, color: theme.ink },
    bankSelectPlaceholder: { ...Typography.BODY, color: theme.inkFaint },
    verifyRow: { flexDirection: 'row', alignItems: 'center', marginTop: Spacing.S },
    verifyCheckingText: { ...Typography.CAPTION, color: theme.inkMuted, marginLeft: Spacing.S },
    verifiedCard: {
      marginTop: Spacing.M,
      padding: Spacing.L,
      borderRadius: Spacing.CARD_RADIUS,
      backgroundColor: theme.brandSoft,
    },
    verifiedHeading: { flexDirection: 'row', alignItems: 'center', gap: Spacing.S },
    verifiedIcon: {
      width: 24,
      height: 24,
      borderRadius: 12,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.brand,
    },
    verifiedTitle: { ...Typography.CAPTION, color: theme.brand, fontWeight: '700' },
    verifiedName: { ...Typography.BODY, color: theme.ink, marginTop: Spacing.S },
    errorText: { ...Typography.ERROR, color: theme.down, marginTop: Spacing.S },
    hintText: { ...Typography.CAPTION, color: theme.inkMuted, marginTop: Spacing.M, marginBottom: Spacing.L },

    primaryButton: {
      height: Spacing.BUTTON_HEIGHT_PRIMARY,
      backgroundColor: theme.brand,
      borderRadius: Spacing.BUTTON_RADIUS,
      justifyContent: 'center',
      alignItems: 'center',
    },
    primaryButtonDisabled: { opacity: 0.4 },
    primaryButtonText: { ...Typography.BUTTON_TEXT, color: theme.background },

    pickerSearch: {
      margin: Spacing.L,
      height: Spacing.INPUT_HEIGHT,
      borderWidth: Spacing.INPUT_BORDER_WIDTH,
      borderColor: theme.hairline,
      borderRadius: Spacing.BUTTON_RADIUS,
      paddingHorizontal: Spacing.L,
      ...Typography.BODY,
      color: theme.ink,
    },
    pickerRow: {
      paddingHorizontal: Spacing.L,
      paddingVertical: Spacing.L,
      borderBottomWidth: 1,
      borderBottomColor: theme.hairline,
    },
    pickerRowWithLogo: { flexDirection: 'row', alignItems: 'center' },
    pickerRowText: { ...Typography.BODY, color: theme.ink },
    pickerEmptyText: { ...Typography.CAPTION, color: theme.inkMuted, textAlign: 'center', marginTop: Spacing.XL },
  });
}
