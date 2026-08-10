import React, { useState } from 'react';
import * as Clipboard from 'expo-clipboard';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  Alert,
  Image,
  ImageSourcePropType,
} from 'react-native';
import { Colors } from '../constants/colors';
import { Typography } from '../constants/typography';
import { Spacing } from '../constants/spacing';
import { virtualAccountService, VirtualAccount, VirtualAccountProvider } from '../services/virtualAccount.service';

interface ProviderFundingBlockProps {
  provider: VirtualAccountProvider;
  providerLabel: string;
  account: VirtualAccount | null;
  initialLoading: boolean;
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
  onCreated,
  onPaystackCheckStarted,
  onPaystackCheckFailed,
}: ProviderFundingBlockProps) {
  const branding = PROVIDER_BRANDING[provider];
  const [showBvnInput, setShowBvnInput] = useState(false);
  const [bvnOrNin, setBvnOrNin] = useState('');
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
    if (provider === 'flutterwave' && !/^\d{11}$/.test(bvnOrNin)) {
      Alert.alert('Bank Transfer', 'Please enter a valid 11-digit BVN or NIN.');
      return;
    }
    setLoading(true);
    const res = await virtualAccountService.create(provider, bvnOrNin);
    setLoading(false);
    if (res.success && res.account) {
      onCreated(res.account);
      setShowBvnInput(false);
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
                <ActivityIndicator color={Colors.GREEN} />
              ) : (
                <Text style={styles.requeryButtonText}>I've transferred — check payment</Text>
              )}
            </TouchableOpacity>
          )}
        </View>
      ) : initialLoading ? (
        <View style={styles.transferCard}>
          <ActivityIndicator color={Colors.GREEN} />
        </View>
      ) : provider === 'paystack' ? (
        <TouchableOpacity
          style={styles.transferButton}
          onPress={handleGetAccount}
          disabled={loading}
        >
          {loading ? (
            <ActivityIndicator color={Colors.GREEN} />
          ) : (
            <Text style={styles.transferButtonText}>Get my Paystack account number</Text>
          )}
        </TouchableOpacity>
      ) : showBvnInput ? (
        <View style={styles.transferCard}>
          <Text style={styles.transferHint}>
            We need your BVN or NIN once to set up your {providerLabel} account number.
          </Text>
          <View style={styles.inputContainer}>
            <TextInput
              style={styles.input}
              value={bvnOrNin}
              onChangeText={(t) => setBvnOrNin(t.replace(/[^0-9]/g, '').slice(0, 11))}
              placeholder="Enter your BVN or NIN"
              placeholderTextColor={Colors.GRAY}
              keyboardType="number-pad"
              maxLength={11}
            />
          </View>
          <TouchableOpacity
            style={[styles.transferButton, bvnOrNin.length !== 11 && styles.transferButtonDisabled]}
            onPress={handleGetAccount}
            disabled={loading || bvnOrNin.length !== 11}
          >
            {loading ? (
              <ActivityIndicator color={Colors.GREEN} />
            ) : (
              <Text style={styles.transferButtonText}>Continue</Text>
            )}
          </TouchableOpacity>
        </View>
      ) : (
        <TouchableOpacity style={styles.transferButton} onPress={() => setShowBvnInput(true)}>
          <Text style={styles.transferButtonText}>Get my {providerLabel} account number</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
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
    color: Colors.GRAY,
    marginLeft: Spacing.M,
    flexShrink: 1,
    textAlign: 'right',
  },
  transferButton: {
    height: Spacing.BUTTON_HEIGHT_PRIMARY,
    borderRadius: Spacing.BUTTON_RADIUS,
    borderWidth: 1,
    borderColor: Colors.GREEN,
    justifyContent: 'center',
    alignItems: 'center',
  },
  transferButtonDisabled: {
    opacity: 0.5,
  },
  transferButtonText: {
    ...Typography.BUTTON_TEXT,
    color: Colors.GREEN,
  },
  transferCard: {
    backgroundColor: Colors.LIGHT_GRAY,
    borderRadius: 12,
    padding: Spacing.L,
  },
  transferHint: {
    ...Typography.CAPTION,
    color: Colors.GRAY,
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
    color: Colors.GRAY,
  },
  transferValue: {
    ...Typography.BODY,
    color: Colors.DARK,
    fontWeight: '600',
    flexShrink: 1,
    textAlign: 'right',
    marginLeft: Spacing.M,
  },
  transferAccount: {
    ...Typography.HEADING,
    color: Colors.GREEN,
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
    borderColor: Colors.GREEN,
    borderRadius: Spacing.BUTTON_RADIUS,
    justifyContent: 'center',
    alignItems: 'center',
  },
  copyButtonText: {
    ...Typography.BUTTON_TEXT,
    color: Colors.GREEN,
  },
  requeryButton: {
    minHeight: 44,
    borderTopWidth: 1,
    borderTopColor: Colors.BORDER,
    marginTop: Spacing.M,
    paddingTop: Spacing.M,
    justifyContent: 'center',
    alignItems: 'center',
  },
  requeryButtonText: {
    ...Typography.BUTTON_TEXT,
    color: Colors.GREEN,
    textAlign: 'center',
  },
  inputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: Spacing.INPUT_BORDER_WIDTH,
    borderColor: Colors.BORDER,
    borderRadius: Spacing.BUTTON_RADIUS,
    height: Spacing.INPUT_HEIGHT,
    paddingHorizontal: Spacing.M,
    marginBottom: Spacing.L,
    backgroundColor: Colors.WHITE,
  },
  input: {
    flex: 1,
    ...Typography.BODY,
    color: Colors.DARK,
    height: '100%',
  },
});
