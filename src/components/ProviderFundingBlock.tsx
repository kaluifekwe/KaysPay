import React, { useState } from 'react';
import * as Clipboard from 'expo-clipboard';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  Image,
  ImageSourcePropType,
} from 'react-native';
import { Typography } from '../constants/typography';
import { Spacing } from '../constants/spacing';
import { AppTheme } from '../constants/theme';
import { useTheme } from './ThemeProvider';
import { virtualAccountService, VirtualAccount, VirtualAccountProvider } from '../services/virtualAccount.service';

interface ProviderFundingBlockProps {
  provider: VirtualAccountProvider;
  providerLabel: string;
  account: VirtualAccount | null;
  initialLoading: boolean;
  /** The caller's own verified NIN (see kycService) — WalletFundingScreen
   *  only ever renders this component once KYC is confirmed verified, so
   *  this is always present in practice; Flutterwave's account-creation
   *  call reuses it instead of asking the user to type a BVN/NIN again. */
  verifiedNin?: string;
  onCreated: (account: VirtualAccount) => void;
  onPaystackCheckStarted?: () => void;
  onPaystackCheckFailed?: () => void;
}

const PROVIDER_BRANDING: Record<
  VirtualAccountProvider,
  { logo: ImageSourcePropType; accessibilityLabel: string }
> = {
  paystack: {
    logo: require('../../assets/payment-providers/paystack.png'),
    accessibilityLabel: 'Paystack payment provider',
  },
  flutterwave: {
    logo: require('../../assets/payment-providers/flutterwave.png'),
    accessibilityLabel: 'Flutterwave payment provider',
  },
};

// One provider's "get my account number" flow (no account / enter BVN-or-NIN
// / static account card) — a user can have one of these per provider at
// once, so WalletFundingScreen renders one block per available provider
// rather than a single global account state.
export default function ProviderFundingBlock({
  provider,
  providerLabel,
  account,
  initialLoading,
  verifiedNin,
  onCreated,
  onPaystackCheckStarted,
  onPaystackCheckFailed,
}: ProviderFundingBlockProps) {
  const { theme } = useTheme();
  const styles = createStyles(theme);
  const branding = PROVIDER_BRANDING[provider];
  const [loading, setLoading] = useState(false);
  const [requeryLoading, setRequeryLoading] = useState(false);
  const [accountCopied, setAccountCopied] = useState(false);

  const handleCopyAccountNumber = async () => {
    if (!account?.account_number) return;
    try {
      await Clipboard.setStringAsync(account.account_number);
      setAccountCopied(true);
      setTimeout(() => setAccountCopied(false), 2000);
    } catch {
      Alert.alert('Copy account number', 'Could not copy the account number. Please try again.');
    }
  };

  const handleGetAccount = async () => {
    if (provider === 'flutterwave' && !/^\d{11}$/.test(verifiedNin || '')) {
      // Shouldn't happen — this component only renders once WalletFundingScreen
      // confirms KYC is verified — but fail loudly rather than silently no-op.
      Alert.alert('Bank Transfer', 'Please verify your identity first.');
      return;
    }
    setLoading(true);
    const res = await virtualAccountService.create(provider, verifiedNin || '');
    setLoading(false);
    if (res.success && res.account) {
      onCreated(res.account);
    } else {
      Alert.alert('Bank Transfer', res.error || 'Could not set up your account number.');
    }
  };

  const handleRequery = async () => {
    onPaystackCheckStarted?.();
    setRequeryLoading(true);
    const result = await virtualAccountService.requeryPaystack();
    setRequeryLoading(false);
    if (!result.success) onPaystackCheckFailed?.();
    Alert.alert(
      result.success ? 'Checking transfer' : 'Could not check transfer',
      result.message || result.error || 'Please try again later.',
    );
  };

  return (
    <View style={styles.wrapper}>
      <View style={styles.providerHeader}>
        <Image
          source={branding.logo}
          style={styles.providerLogo}
          resizeMode="contain"
          accessible
          accessibilityLabel={branding.accessibilityLabel}
        />
        <Text style={styles.providerCaption}>Payment provider</Text>
      </View>
      {account ? (
        <View style={styles.transferCard}>
          <Text style={styles.transferHint}>
            Transfer any amount to this account. Your wallet is credited automatically.
          </Text>
          <View style={styles.transferRow}>
            <Text style={styles.transferLabel}>Bank</Text>
            <Text style={styles.transferValue}>{account.bank_name}</Text>
          </View>
          <View style={styles.transferRow}>
            <Text style={styles.transferLabel}>Account Number</Text>
            <View style={styles.accountNumberGroup}>
              <Text style={styles.transferAccount} selectable>
                {account.account_number}
              </Text>
              <TouchableOpacity
                style={styles.copyButton}
                onPress={handleCopyAccountNumber}
                accessibilityRole="button"
                accessibilityLabel={`Copy ${providerLabel} account number`}
              >
                <Text style={styles.copyButtonText}>{accountCopied ? 'Copied ✓' : 'Copy'}</Text>
              </TouchableOpacity>
            </View>
          </View>
          <View style={styles.transferRow}>
            <Text style={styles.transferLabel}>Account Name</Text>
            <Text style={styles.transferValue}>{account.account_name}</Text>
          </View>
          {provider === 'paystack' && (
            <TouchableOpacity
              style={styles.requeryButton}
              onPress={handleRequery}
              disabled={requeryLoading}
            >
              {requeryLoading ? (
                <ActivityIndicator color={theme.brand} />
              ) : (
                <Text style={styles.requeryButtonText}>I've transferred — check payment</Text>
              )}
            </TouchableOpacity>
          )}
        </View>
      ) : initialLoading ? (
        <View style={styles.transferCard}>
          <ActivityIndicator color={theme.brand} />
        </View>
      ) : (
        // Both providers now use the same one-tap flow: identity is already
        // verified before this component ever renders (see
        // WalletFundingScreen), so there's nothing left to type here.
        <TouchableOpacity
          style={styles.transferButton}
          onPress={handleGetAccount}
          disabled={loading}
        >
          {loading ? (
            <ActivityIndicator color={theme.brand} />
          ) : (
            <Text style={styles.transferButtonText}>Get my {providerLabel} account number</Text>
          )}
        </TouchableOpacity>
      )}
    </View>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
  wrapper: {
    marginBottom: Spacing.L,
  },
  providerHeader: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: Spacing.S,
  },
  providerLogo: {
    width: 150,
    height: 36,
  },
  providerCaption: {
    ...Typography.CAPTION,
    color: theme.inkMuted,
    marginLeft: Spacing.M,
    flexShrink: 1,
    textAlign: 'right',
  },
  transferButton: {
    height: Spacing.BUTTON_HEIGHT_PRIMARY,
    borderRadius: Spacing.BUTTON_RADIUS,
    borderWidth: 1,
    borderColor: theme.brand,
    justifyContent: 'center',
    alignItems: 'center',
  },
  transferButtonDisabled: {
    opacity: 0.5,
  },
  transferButtonText: {
    ...Typography.BUTTON_TEXT,
    color: theme.brand,
  },
  transferCard: {
    backgroundColor: theme.surfaceRaised,
    borderRadius: 12,
    padding: Spacing.L,
  },
  transferHint: {
    ...Typography.CAPTION,
    color: theme.inkMuted,
    marginBottom: Spacing.M,
  },
  transferRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: Spacing.S,
  },
  transferLabel: {
    ...Typography.BODY,
    color: theme.inkMuted,
  },
  transferValue: {
    ...Typography.BODY,
    color: theme.ink,
    fontWeight: '600',
    flexShrink: 1,
    textAlign: 'right',
    marginLeft: Spacing.M,
  },
  transferAccount: {
    ...Typography.HEADING,
    color: theme.brand,
    fontWeight: '700',
    letterSpacing: 1,
  },
  accountNumberGroup: {
    alignItems: 'flex-end',
    marginLeft: Spacing.M,
    flexShrink: 1,
  },
  copyButton: {
    minWidth: 72,
    minHeight: 44,
    marginTop: Spacing.XS,
    paddingHorizontal: Spacing.M,
    borderWidth: 1,
    borderColor: theme.brand,
    borderRadius: Spacing.BUTTON_RADIUS,
    justifyContent: 'center',
    alignItems: 'center',
  },
  copyButtonText: {
    ...Typography.BUTTON_TEXT,
    color: theme.brand,
  },
  requeryButton: {
    minHeight: 44,
    borderTopWidth: 1,
    borderTopColor: theme.border,
    marginTop: Spacing.M,
    paddingTop: Spacing.M,
    justifyContent: 'center',
    alignItems: 'center',
  },
  requeryButtonText: {
    ...Typography.BUTTON_TEXT,
    color: theme.brand,
    textAlign: 'center',
  },
  });
}
