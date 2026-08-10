import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTransactionAuth } from '../components/TransactionAuthProvider';
import ProviderLogo from '../components/ProviderLogo';
import { Colors } from '../constants/colors';
import { Spacing } from '../constants/spacing';
import { Typography } from '../constants/typography';
import { vtuService, type SavedBillingAccount, type TVBouquet, type TVProvider } from '../services/vtu.service';
import { formatNaira } from '../utils/formatCurrency';
import { TV_LOGOS } from '../utils/providerLogos';

type VerifyState = 'idle' | 'checking' | 'verified' | 'failed';

export default function TVPayScreen({ navigation, route }: any) {
  const provider = route.params.provider as TVProvider;
  const { authorize } = useTransactionAuth();
  const insets = useSafeAreaInsets();
  const scrollRef = useRef<ScrollView>(null);
  const verifyRequestRef = useRef(0);

  const [smartcardNumber, setSmartcardNumber] = useState('');
  const [bouquets, setBouquets] = useState<TVBouquet[]>([]);
  const [selectedBouquet, setSelectedBouquet] = useState<TVBouquet | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [verifyState, setVerifyState] = useState<VerifyState>('idle');
  const [verifiedName, setVerifiedName] = useState<string | null>(null);
  const [verifiedBouquet, setVerifiedBouquet] = useState<string | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [savedAccounts, setSavedAccounts] = useState<SavedBillingAccount[]>([]);
  const [cachedPreviewName, setCachedPreviewName] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    vtuService.getSavedBillingAccounts('tv', provider.id).then((accounts) => {
      if (active) setSavedAccounts(accounts);
    });
    return () => { active = false; };
  }, [provider.id]);

  useFocusEffect(useCallback(() => {
    let cancelled = false;
    const cached = vtuService.getBouquets(provider.id);
    setBouquets(cached);
    setCatalogLoading(cached.length === 0);

    vtuService.refreshBouquets(provider.id).then((fresh) => {
      if (cancelled) return;
      setBouquets(fresh);
      setSelectedBouquet((selected) =>
        selected ? fresh.find((bouquet) => bouquet.id === selected.id) ?? null : null,
      );
    }).finally(() => {
      if (!cancelled) setCatalogLoading(false);
    });

    return () => { cancelled = true; };
  }, [provider.id]));

  const handleSmartcardChange = useCallback((text: string) => {
    verifyRequestRef.current += 1;
    setSmartcardNumber(text.replace(/\D/g, '').slice(0, 13));
    setVerifyState('idle');
    setVerifiedName(null);
    setVerifiedBouquet(null);
    setVerifyError(null);
    setSelectedBouquet(null);
    setErrorMessage('');
    setCachedPreviewName(null);
  }, []);

  const handleSavedAccountSelect = useCallback((account: SavedBillingAccount) => {
    handleSmartcardChange(account.account_number);
    setCachedPreviewName(account.customer_name);
  }, [handleSmartcardChange]);

  const handleVerifySmartcard = useCallback(async () => {
    const digits = smartcardNumber.replace(/\D/g, '');
    if (digits.length < 8) return;

    setVerifyState('checking');
    setVerifyError(null);
    const requestId = ++verifyRequestRef.current;
    const result = await vtuService.verifyTVSmartcard(provider.id, digits);
    if (requestId !== verifyRequestRef.current) return;

    if (result.ok && result.customerName) {
      setVerifiedName(result.customerName);
      setVerifiedBouquet(result.currentBouquet);
      setVerifyState('verified');
    } else {
      setVerifiedName(null);
      setVerifiedBouquet(null);
      setVerifyError(result.error || 'Could not verify this smartcard number.');
      setVerifyState('failed');
    }
  }, [provider.id, smartcardNumber]);

  useEffect(() => {
    const digits = smartcardNumber.replace(/\D/g, '');
    if (digits.length < 8 || verifyState !== 'idle') return;
    const timer = setTimeout(() => { void handleVerifySmartcard(); }, 900);
    return () => clearTimeout(timer);
  }, [smartcardNumber, verifyState, handleVerifySmartcard]);

  const isValidSmartcard = smartcardNumber.length >= 8;
  const canProceed = verifyState === 'verified' && !!verifiedName && !!selectedBouquet;

  const payHint = useMemo(() => {
    if (!isValidSmartcard) return 'Enter your smartcard number';
    if (verifyState === 'checking') return 'Verifying smartcard number…';
    if (verifyState !== 'verified') return 'Verify the smartcard number to continue';
    if (!selectedBouquet) return 'Choose a bouquet to continue';
    return null;
  }, [isValidSmartcard, verifyState, selectedBouquet]);

  const handleBuy = useCallback(async () => {
    if (!canProceed || !selectedBouquet || !verifiedName) return;
    const digits = smartcardNumber.replace(/\D/g, '');
    const authResult = await authorize({
      title: 'Confirm TV Subscription',
      amount: selectedBouquet.amount,
      subtitle: `${provider.name} • ${digits} • ${verifiedName}`,
    });
    if (!authResult) return;

    setErrorMessage('');
    navigation.navigate('TransactionStatus', {
      title: 'TV Subscription',
      amount: selectedBouquet.amount,
      recipient: digits,
      paymentMethod: 'Balance',
      request: {
        kind: 'tv',
        providerId: provider.id,
        smartcardNumber: digits,
        bouquetId: selectedBouquet.id,
        amount: selectedBouquet.amount,
        authToken: authResult.token,
      },
    });
  }, [authorize, canProceed, navigation, provider, selectedBouquet, smartcardNumber, verifiedName]);

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          ref={scrollRef}
          style={styles.flex}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <TouchableOpacity style={styles.backButton} activeOpacity={0.6} onPress={() => navigation.goBack()}>
            <Text style={styles.backText}>{'<'}</Text>
          </TouchableOpacity>

          <View style={styles.headingRow}>
            <ProviderLogo source={TV_LOGOS[provider.id]} fallbackLabel={provider.name} size={44} />
            <View style={styles.headingText}>
              <Text style={styles.title}>{provider.name} Subscription</Text>
              <Text style={styles.subtitle}>Verify your smartcard, then choose a bouquet</Text>
            </View>
          </View>

          <View style={styles.section}>
            <Text style={styles.label}>Smartcard Number</Text>
            {savedAccounts.length > 0 ? (
              <View style={styles.savedAccounts}>
                <Text style={styles.savedLabel}>Previously used smartcards</Text>
                {savedAccounts.map((account) => (
                  <TouchableOpacity
                    key={account.id}
                    style={styles.savedAccount}
                    onPress={() => handleSavedAccountSelect(account)}
                    activeOpacity={0.75}
                  >
                    <Text style={styles.savedNumber}>{account.account_number}</Text>
                    <Text style={styles.savedName} numberOfLines={1}>{account.customer_name}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            ) : null}
            <TextInput
              style={styles.input}
              value={smartcardNumber}
              onChangeText={handleSmartcardChange}
              placeholder="Enter smartcard number"
              placeholderTextColor={Colors.GRAY}
              keyboardType="number-pad"
              maxLength={13}
            />

            {verifyState === 'checking' && (
              <View style={styles.statusRow}>
                <ActivityIndicator size="small" color={Colors.GREEN} />
                <Text style={styles.statusText}>Verifying smartcard…</Text>
              </View>
            )}
            {verifyState === 'checking' && cachedPreviewName ? (
              <Text style={styles.cachedPreview}>Previously verified: {cachedPreviewName}</Text>
            ) : null}
            {verifyState === 'verified' && verifiedName && (
              <View style={styles.verifiedCard}>
                <Text style={styles.verifiedTitle}>✓ Verified — {verifiedName}</Text>
                {verifiedBouquet ? <Text style={styles.verifiedDetail}>Current bouquet: {verifiedBouquet}</Text> : null}
              </View>
            )}
            {verifyState === 'failed' && verifyError ? (
              <View>
                <Text style={styles.verifyError}>{verifyError}</Text>
                <TouchableOpacity style={styles.tryAgainButton} onPress={handleVerifySmartcard} activeOpacity={0.8}>
                  <Text style={styles.tryAgainText}>Try again</Text>
                </TouchableOpacity>
              </View>
            ) : null}
          </View>

          <View style={styles.section}>
              <Text style={styles.label}>Choose a Bouquet</Text>
              {catalogLoading ? (
                <View style={styles.statusRow}>
                  <ActivityIndicator size="small" color={Colors.GREEN} />
                  <Text style={styles.statusText}>Loading current prices…</Text>
                </View>
              ) : bouquets.length === 0 ? (
                <View style={styles.emptyState}>
                  <Text style={styles.emptyText}>No bouquets are currently available for {provider.name}.</Text>
                </View>
              ) : bouquets.map((bouquet) => {
                const selected = selectedBouquet?.id === bouquet.id;
                return (
                  <TouchableOpacity
                    key={bouquet.id}
                    style={[styles.bouquetCard, selected && styles.bouquetCardSelected]}
                    onPress={() => setSelectedBouquet(selected ? null : bouquet)}
                    activeOpacity={0.7}
                  >
                    <View style={styles.bouquetInfo}>
                      <Text style={styles.bouquetName}>{bouquet.name}</Text>
                      <Text style={styles.bouquetProvider}>{provider.name}</Text>
                    </View>
                    <Text style={[styles.bouquetAmount, selected && styles.bouquetAmountSelected]}>
                      {formatNaira(bouquet.amount)}
                    </Text>
                  </TouchableOpacity>
                );
              })}
          </View>

          {errorMessage ? <Text style={styles.verifyError}>{errorMessage}</Text> : null}
        </ScrollView>

        <View style={[styles.bottomBar, { paddingBottom: insets.bottom + Spacing.L }]}>
          {selectedBouquet && (
            <View style={styles.summary}>
              <Text style={styles.summaryText} numberOfLines={1}>{provider.name} • {selectedBouquet.name}</Text>
              <Text style={styles.summaryAmount}>{formatNaira(selectedBouquet.amount)}</Text>
            </View>
          )}
          {payHint ? <Text style={styles.payHint}>{payHint}</Text> : null}
          <TouchableOpacity
            style={[styles.payButton, !canProceed && styles.payButtonDisabled]}
            onPress={handleBuy}
            disabled={!canProceed}
          >
            <Text style={styles.payButtonText}>Pay</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.WHITE },
  flex: { flex: 1 },
  scrollContent: {
    paddingHorizontal: Spacing.SCREEN_PADDING,
    paddingTop: Spacing.M,
    paddingBottom: 190,
  },
  backButton: { width: 48, height: 48, justifyContent: 'center', alignItems: 'center', marginBottom: Spacing.M },
  backText: { fontSize: 28, fontWeight: '600', color: Colors.DARK },
  headingRow: { flexDirection: 'row', alignItems: 'center', marginBottom: Spacing.XL },
  headingText: { flex: 1, marginLeft: Spacing.M },
  title: { ...Typography.SCREEN_TITLE, fontSize: 22, marginBottom: 4 },
  subtitle: { ...Typography.CAPTION, color: Colors.GRAY },
  section: { marginBottom: Spacing.XL },
  label: { ...Typography.SECTION_HEADING, marginBottom: Spacing.M },
  savedAccounts: { marginBottom: Spacing.M },
  savedLabel: { ...Typography.CAPTION, color: Colors.GRAY, marginBottom: Spacing.S },
  savedAccount: { minHeight: 52, borderWidth: 1, borderColor: Colors.BORDER, borderRadius: Spacing.BUTTON_RADIUS, paddingHorizontal: Spacing.M, paddingVertical: Spacing.S, marginBottom: Spacing.S, justifyContent: 'center' },
  savedNumber: { ...Typography.BODY, color: Colors.DARK, fontWeight: '600' },
  savedName: { ...Typography.CAPTION, color: Colors.GRAY, marginTop: 2 },
  cachedPreview: { ...Typography.CAPTION, color: Colors.GRAY, marginTop: Spacing.S },
  input: {
    height: Spacing.INPUT_HEIGHT,
    borderWidth: Spacing.INPUT_BORDER_WIDTH,
    borderColor: Colors.BORDER,
    borderRadius: Spacing.BUTTON_RADIUS,
    paddingHorizontal: Spacing.L,
    ...Typography.BODY,
    color: Colors.DARK,
  },
  statusRow: { minHeight: 44, flexDirection: 'row', alignItems: 'center', marginTop: Spacing.S },
  statusText: { ...Typography.BODY, color: Colors.GRAY, marginLeft: Spacing.S },
  verifiedCard: { marginTop: Spacing.M, padding: Spacing.M, borderRadius: Spacing.CARD_RADIUS, backgroundColor: Colors.GREEN_LIGHT },
  verifiedTitle: { ...Typography.BODY, color: Colors.GREEN_DARK, fontWeight: '700' },
  verifiedDetail: { ...Typography.CAPTION, color: Colors.GREEN_DARK, marginTop: 4 },
  verifyError: { ...Typography.ERROR, marginTop: Spacing.S },
  tryAgainButton: {
    minHeight: Spacing.TOUCH_TARGET_MIN,
    marginTop: Spacing.M,
    borderWidth: 1,
    borderColor: Colors.GREEN,
    borderRadius: Spacing.BUTTON_RADIUS,
    justifyContent: 'center',
    alignItems: 'center',
  },
  tryAgainText: { ...Typography.BUTTON_TEXT, color: Colors.GREEN },
  bouquetCard: {
    minHeight: Spacing.LIST_ITEM_HEIGHT,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: Spacing.CARD_PADDING,
    paddingVertical: Spacing.M,
    marginBottom: Spacing.M,
    borderWidth: 1,
    borderColor: Colors.BORDER,
    borderRadius: Spacing.CARD_RADIUS,
  },
  bouquetCardSelected: { borderColor: Colors.GREEN, borderWidth: 2, backgroundColor: Colors.GREEN_10 },
  bouquetInfo: { flex: 1, paddingRight: Spacing.M },
  bouquetName: { ...Typography.CARD_TITLE, marginBottom: 2 },
  bouquetProvider: { ...Typography.CAPTION },
  bouquetAmount: { ...Typography.AMOUNT_SMALL, color: Colors.DARK },
  bouquetAmountSelected: { color: Colors.GREEN },
  emptyState: { padding: Spacing.L, borderRadius: Spacing.CARD_RADIUS, backgroundColor: Colors.LIGHT_GRAY },
  emptyText: { ...Typography.BODY, color: Colors.GRAY, textAlign: 'center' },
  bottomBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: Spacing.SCREEN_PADDING,
    paddingTop: Spacing.L,
    borderTopWidth: 1,
    borderTopColor: Colors.BORDER,
    backgroundColor: Colors.WHITE,
  },
  summary: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: Spacing.M },
  summaryText: { ...Typography.BODY, flex: 1, paddingRight: Spacing.M },
  summaryAmount: { ...Typography.AMOUNT_SMALL },
  payHint: { ...Typography.CAPTION, color: Colors.GRAY, textAlign: 'center', marginBottom: Spacing.M },
  payButton: { height: Spacing.BUTTON_HEIGHT_PRIMARY, borderRadius: Spacing.BUTTON_RADIUS, backgroundColor: Colors.GREEN, justifyContent: 'center', alignItems: 'center' },
  payButtonDisabled: { opacity: 0.5 },
  payButtonText: { ...Typography.BUTTON_TEXT },
});
