import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
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
import { Ionicons } from '@expo/vector-icons';
import { useTransactionAuth } from '../components/TransactionAuthProvider';
import ProviderLogo from '../components/ProviderLogo';
import { AppTheme } from '../constants/theme';
import { useTheme } from '../components/ThemeProvider';
import { Spacing } from '../constants/spacing';
import { Typography } from '../constants/typography';
import { vtuService, type SavedBillingAccount, type TVBouquet, type TVProvider } from '../services/vtu.service';
import { formatNaira } from '../utils/formatCurrency';
import { TV_LOGOS } from '../utils/providerLogos';

type VerifyState = 'idle' | 'checking' | 'verified' | 'failed';

function formatDueDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export default function TVPayScreen({ navigation, route }: any) {
  const provider = route.params.provider as TVProvider;
  const { authorize } = useTransactionAuth();
  const { theme } = useTheme();
  const styles = createStyles(theme);
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
  const [verifiedStatus, setVerifiedStatus] = useState<string | null>(null);
  const [verifiedDueDate, setVerifiedDueDate] = useState<string | null>(null);
  const [verifiedRenewalAmount, setVerifiedRenewalAmount] = useState<number | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [savedAccounts, setSavedAccounts] = useState<SavedBillingAccount[]>([]);
  // True until the first saved-accounts fetch settles. Without this, the
  // screen has no way to tell "still checking" apart from "genuinely none
  // saved" — savedAccounts starts as [], so the blank manual-entry box
  // rendered first on every visit, then got replaced by the saved smartcard
  // once the network call returned, even for one saved the day before.
  const [savedAccountsLoading, setSavedAccountsLoading] = useState(true);
  const [cachedPreviewName, setCachedPreviewName] = useState<string | null>(null);
  const [showManualInput, setShowManualInput] = useState(false);

  const selectedSavedAccount = useMemo(
    () => savedAccounts.find((account) => account.account_number === smartcardNumber) ?? null,
    [savedAccounts, smartcardNumber],
  );

  const loadSavedAccounts = useCallback(async () => {
    try {
      const accounts = await vtuService.getSavedBillingAccounts('tv', provider.id);
      setSavedAccounts(accounts);
    } finally {
      setSavedAccountsLoading(false);
    }
  }, [provider.id]);

  useFocusEffect(useCallback(() => {
    void loadSavedAccounts();
  }, [loadSavedAccounts]));

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
    setVerifiedStatus(null);
    setVerifiedDueDate(null);
    setVerifiedRenewalAmount(null);
    setVerifyError(null);
    setSelectedBouquet(null);
    setErrorMessage('');
    setCachedPreviewName(null);
  }, []);

  const handleSavedAccountSelect = useCallback((account: SavedBillingAccount) => {
    setShowManualInput(false);
    handleSmartcardChange(account.account_number);
    setCachedPreviewName(account.customer_name);
    setVerifiedName(account.customer_name);
    // Show the due date and renewal amount from the cached snapshot too, not
    // just the name. Previously these were blank until a live provider call
    // returned — measured at ~1.0-1.4s typical and up to ~3.6s cold, landing
    // exactly when the customer had chosen a card and was ready to pay. The
    // refresh below still runs and corrects anything that has moved.
    setVerifiedDueDate(account.due_date);
    setVerifiedRenewalAmount(
      // Stored in kobo; formatNaira renders naira.
      account.renewal_amount_kobo !== null ? account.renewal_amount_kobo / 100 : null,
    );
    setVerifyState('verified');
  }, [handleSmartcardChange]);

  const handleUseAnotherSmartcard = useCallback(() => {
    setShowManualInput(true);
    handleSmartcardChange('');
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
      setVerifiedStatus(result.accountStatus);
      setVerifiedDueDate(result.dueDate);
      setVerifiedRenewalAmount(result.renewalAmount);
      setVerifyState('verified');
      setShowManualInput(false);
      void loadSavedAccounts();
    } else {
      setVerifiedName(null);
      setVerifiedBouquet(null);
      setVerifiedStatus(null);
      setVerifiedDueDate(null);
      setVerifiedRenewalAmount(null);
      setVerifyError(result.error || 'Could not verify this smartcard number.');
      setVerifyState('failed');
    }
  }, [provider.id, smartcardNumber, loadSavedAccounts]);

  // Saved accounts render immediately from our server-owned verified cache.
  // Refresh silently so provider latency does not block plan selection; the
  // purchase endpoint still requires a fresh server verification proof.
  useEffect(() => {
    if (!cachedPreviewName || verifyState !== 'verified') return;
    const digits = smartcardNumber.replace(/\D/g, '');
    if (digits.length < 8) return;

    let cancelled = false;
    void vtuService.verifyTVSmartcard(provider.id, digits).then((result) => {
      if (cancelled || !result.ok || !result.customerName) return;
      setVerifiedName(result.customerName);
      setVerifiedBouquet(result.currentBouquet);
      setVerifiedStatus(result.accountStatus);
      setVerifiedDueDate(result.dueDate);
      setVerifiedRenewalAmount(result.renewalAmount);
      void loadSavedAccounts();
    });
    return () => { cancelled = true; };
  }, [cachedPreviewName, loadSavedAccounts, provider.id, smartcardNumber, verifyState]);

  const handleRemoveSavedAccount = useCallback((account: SavedBillingAccount) => {
    Alert.alert(
      'Remove saved account?',
      `Remove ${account.account_number} from your saved ${provider.name} accounts?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            const removed = await vtuService.deleteSavedBillingAccount(account.id);
            if (!removed) {
              Alert.alert('Could not remove account', 'Please try again.');
              return;
            }
            setSavedAccounts((current) => current.filter((item) => item.id !== account.id));
            if (account.account_number === smartcardNumber) {
              setShowManualInput(true);
              handleSmartcardChange('');
            }
          },
        },
      ],
    );
  }, [handleSmartcardChange, provider.name, smartcardNumber]);

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
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <ScrollView
          ref={scrollRef}
          style={styles.flex}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'}
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
            {savedAccountsLoading ? (
              // Distinguishes "still checking" from "genuinely none saved" so
              // the blank manual-entry box below never flashes on screen
              // before a saved smartcard that is about to appear anyway.
              <View style={styles.savedAccountsLoadingRow}>
                <ActivityIndicator size="small" color={theme.inkMuted} />
                <Text style={styles.savedAccountsLoadingText}>Checking for saved smartcards…</Text>
              </View>
            ) : savedAccounts.length > 0 ? (
              <View style={styles.savedAccounts}>
                <Text style={styles.savedLabel}>Saved smartcards</Text>
                {savedAccounts.map((account) => (
                  <View
                    key={account.id}
                    style={[
                      styles.savedAccount,
                      selectedSavedAccount?.id === account.id && styles.savedAccountSelected,
                    ]}
                  >
                    <TouchableOpacity style={styles.savedAccountSelect} onPress={() => handleSavedAccountSelect(account)} activeOpacity={0.75}>
                      <View
                        style={[
                          styles.savedAccountIcon,
                          selectedSavedAccount?.id === account.id && styles.savedAccountIconSelected,
                        ]}
                      >
                        <Ionicons
                          name={selectedSavedAccount?.id === account.id ? 'checkmark' : 'card-outline'}
                          size={20}
                          color={selectedSavedAccount?.id === account.id ? '#FFFFFF' : theme.brand}
                        />
                      </View>
                      <View style={styles.savedAccountCopy}>
                        <Text style={styles.savedNumber}>{account.account_number}</Text>
                        <Text style={styles.savedName} numberOfLines={1}>{account.customer_name}</Text>
                      </View>
                      {selectedSavedAccount?.id === account.id ? (
                        <Text style={styles.selectedBadge}>Selected</Text>
                      ) : null}
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.removeSavedButton} onPress={() => handleRemoveSavedAccount(account)} activeOpacity={0.75}>
                      <Ionicons name="trash-outline" size={18} color={theme.down} />
                      <Text style={styles.removeSavedText}>Remove</Text>
                    </TouchableOpacity>
                  </View>
                ))}

                {!showManualInput ? (
                  <TouchableOpacity
                    style={styles.useAnotherButton}
                    onPress={handleUseAnotherSmartcard}
                    activeOpacity={0.75}
                  >
                    <Ionicons name="add" size={22} color={theme.brand} />
                    <Text style={styles.useAnotherText}>Use another smartcard</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            ) : null}
            {!savedAccountsLoading && (savedAccounts.length === 0 || showManualInput) ? (
              <TextInput
                style={styles.input}
                value={smartcardNumber}
                onChangeText={handleSmartcardChange}
                placeholder="Enter smartcard number"
                placeholderTextColor={theme.inkMuted}
                keyboardType="number-pad"
                maxLength={13}
              />
            ) : null}

            {verifyState === 'checking' && (
              <View style={styles.statusRow}>
                <ActivityIndicator size="small" color={theme.brand} />
                <Text style={styles.statusText}>Verifying smartcard…</Text>
              </View>
            )}
            {verifyState === 'checking' && cachedPreviewName ? (
              <Text style={styles.cachedPreview}>Previously verified: {cachedPreviewName}</Text>
            ) : null}
            {verifyState === 'verified' && verifiedName && (
              <View style={styles.verifiedCard}>
                <View style={styles.verifiedHeading}>
                  <View style={styles.verifiedIcon}>
                    <Ionicons name="checkmark" size={16} color={'#FFFFFF'} />
                  </View>
                  <Text style={styles.verifiedTitle}>Account verified</Text>
                </View>
                <Text style={styles.verifiedName}>{verifiedName}</Text>

                {(verifiedRenewalAmount !== null || verifiedDueDate) ? (
                  <View style={styles.verifiedFacts}>
                    {verifiedRenewalAmount !== null ? (
                      <View style={styles.verifiedFact}>
                        <Text style={styles.verifiedFactLabel}>Renewal amount</Text>
                        <Text style={styles.verifiedFactValue}>{formatNaira(verifiedRenewalAmount)}</Text>
                      </View>
                    ) : null}
                    {verifiedDueDate ? (
                      <View style={styles.verifiedFact}>
                        <Text style={styles.verifiedFactLabel}>Due date</Text>
                        <Text style={styles.verifiedFactValue}>{formatDueDate(verifiedDueDate)}</Text>
                      </View>
                    ) : null}
                  </View>
                ) : null}
                {verifiedStatus ? <Text style={styles.verifiedDetail}>Account status: {verifiedStatus}</Text> : null}
                {verifiedBouquet ? <Text style={styles.verifiedDetail}>Current bouquet: {verifiedBouquet}</Text> : null}
                {verifiedStatus?.toLowerCase() === 'suspended' ? (
                  <Text style={styles.statusExplanation}>
                    This subscription is currently inactive. Renewing the correct package may reactivate it.
                  </Text>
                ) : null}
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
                  <ActivityIndicator size="small" color={theme.brand} />
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

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.background },
  flex: { flex: 1 },
  scrollContent: {
    paddingHorizontal: Spacing.SCREEN_PADDING,
    paddingTop: Spacing.M,
    paddingBottom: 190,
  },
  backButton: { width: 48, height: 48, justifyContent: 'center', alignItems: 'center', marginBottom: Spacing.M },
  backText: { fontSize: 28, fontWeight: '600', color: theme.ink },
  headingRow: { flexDirection: 'row', alignItems: 'center', marginBottom: Spacing.XL },
  headingText: { flex: 1, marginLeft: Spacing.M },
  title: { ...Typography.SCREEN_TITLE, color: theme.ink, fontSize: 22, marginBottom: 4 },
  subtitle: { ...Typography.CAPTION, color: theme.inkMuted },
  section: { marginBottom: Spacing.XL },
  label: { ...Typography.SECTION_HEADING, color: theme.ink, marginBottom: Spacing.M },
  savedAccounts: { marginBottom: Spacing.M, gap: Spacing.M },
  savedLabel: { ...Typography.CAPTION, color: theme.inkMuted, marginBottom: Spacing.S },
  savedAccountsLoadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.S,
    paddingVertical: Spacing.M,
    marginBottom: Spacing.M,
  },
  savedAccountsLoadingText: { ...Typography.CAPTION, color: theme.inkMuted },
  savedAccount: { minHeight: 72, flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: theme.border, borderRadius: Spacing.BUTTON_RADIUS, backgroundColor: '#FFFFFF' },
  savedAccountSelected: { borderColor: theme.brand, backgroundColor: theme.brandSoft },
  savedAccountSelect: { flex: 1, minHeight: 70, paddingHorizontal: Spacing.M, paddingVertical: Spacing.S, flexDirection: 'row', alignItems: 'center', gap: Spacing.M },
  savedAccountIcon: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.brandSoft },
  savedAccountIconSelected: { backgroundColor: theme.brand },
  savedAccountCopy: { flex: 1 },
  selectedBadge: { ...Typography.CAPTION, color: theme.brand, fontWeight: '700', backgroundColor: theme.brandSoft, borderRadius: 12, paddingHorizontal: Spacing.M, paddingVertical: Spacing.S },
  removeSavedButton: { minWidth: 76, minHeight: 70, justifyContent: 'center', alignItems: 'center', gap: Spacing.XS, paddingHorizontal: Spacing.S },
  removeSavedText: { ...Typography.CAPTION, color: theme.down, fontWeight: '600' },
  savedNumber: { ...Typography.BODY, color: theme.ink, fontWeight: '600' },
  savedName: { ...Typography.CAPTION, color: theme.inkMuted, marginTop: 2 },
  useAnotherButton: { minHeight: Spacing.TOUCH_TARGET_MIN, borderWidth: 1, borderStyle: 'dashed', borderColor: theme.brand, borderRadius: Spacing.BUTTON_RADIUS, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: Spacing.M },
  useAnotherText: { ...Typography.BODY, color: theme.brand, fontWeight: '700' },
  cachedPreview: { ...Typography.CAPTION, color: theme.inkMuted, marginTop: Spacing.S },
  input: {
    height: Spacing.INPUT_HEIGHT,
    borderWidth: Spacing.INPUT_BORDER_WIDTH,
    borderColor: theme.border,
    borderRadius: Spacing.BUTTON_RADIUS,
    paddingHorizontal: Spacing.L,
    ...Typography.BODY,
    color: theme.ink,
  },
  statusRow: { minHeight: 44, flexDirection: 'row', alignItems: 'center', marginTop: Spacing.S },
  statusText: { ...Typography.BODY, color: theme.inkMuted, marginLeft: Spacing.S },
  verifiedCard: { marginTop: Spacing.M, padding: Spacing.L, borderRadius: Spacing.CARD_RADIUS, backgroundColor: theme.brandSoft },
  verifiedHeading: { flexDirection: 'row', alignItems: 'center', gap: Spacing.M },
  verifiedIcon: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.brand },
  verifiedTitle: { ...Typography.BODY, color: theme.brand, fontWeight: '700' },
  verifiedName: { ...Typography.BODY, color: theme.ink, marginTop: Spacing.M },
  verifiedFacts: { flexDirection: 'row', gap: Spacing.L, marginTop: Spacing.L },
  verifiedFact: { flex: 1 },
  verifiedFactLabel: { ...Typography.CAPTION, color: theme.inkMuted, marginBottom: Spacing.S },
  verifiedFactValue: { ...Typography.CARD_TITLE, color: theme.ink },
  verifiedDetail: { ...Typography.CAPTION, color: theme.brand, marginTop: Spacing.M },
  statusExplanation: { ...Typography.CAPTION, color: theme.ink, marginTop: Spacing.S },
  verifyError: { ...Typography.ERROR, marginTop: Spacing.S },
  tryAgainButton: {
    minHeight: Spacing.TOUCH_TARGET_MIN,
    marginTop: Spacing.M,
    borderWidth: 1,
    borderColor: theme.brand,
    borderRadius: Spacing.BUTTON_RADIUS,
    justifyContent: 'center',
    alignItems: 'center',
  },
  tryAgainText: { ...Typography.BUTTON_TEXT, color: theme.brand },
  bouquetCard: {
    minHeight: Spacing.LIST_ITEM_HEIGHT,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: Spacing.CARD_PADDING,
    paddingVertical: Spacing.M,
    marginBottom: Spacing.M,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: Spacing.CARD_RADIUS,
  },
  bouquetCardSelected: { borderColor: theme.brand, borderWidth: 2, backgroundColor: theme.brandSoft },
  bouquetInfo: { flex: 1, paddingRight: Spacing.M },
  bouquetName: { ...Typography.CARD_TITLE, color: theme.ink, marginBottom: 2 },
  bouquetProvider: { ...Typography.CAPTION, color: theme.inkMuted },
  bouquetAmount: { ...Typography.AMOUNT_SMALL, color: theme.ink },
  bouquetAmountSelected: { color: theme.brand },
  emptyState: { padding: Spacing.L, borderRadius: Spacing.CARD_RADIUS, backgroundColor: theme.surfaceRaised },
  emptyText: { ...Typography.BODY, color: theme.inkMuted, textAlign: 'center' },
  bottomBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: Spacing.SCREEN_PADDING,
    paddingTop: Spacing.L,
    borderTopWidth: 1,
    borderTopColor: theme.border,
    backgroundColor: '#FFFFFF',
  },
  summary: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: Spacing.M },
  summaryText: { ...Typography.BODY, color: theme.ink, flex: 1, paddingRight: Spacing.M },
  summaryAmount: { ...Typography.AMOUNT_SMALL, color: theme.brand },
  payHint: { ...Typography.CAPTION, color: theme.inkMuted, textAlign: 'center', marginBottom: Spacing.M },
  payButton: { height: Spacing.BUTTON_HEIGHT_PRIMARY, borderRadius: Spacing.BUTTON_RADIUS, backgroundColor: theme.brand, justifyContent: 'center', alignItems: 'center' },
  payButtonDisabled: { opacity: 0.5 },
  payButtonText: { ...Typography.BUTTON_TEXT },
  });
}
