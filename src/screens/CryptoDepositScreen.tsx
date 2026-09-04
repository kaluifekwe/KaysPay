import React, { useCallback, useEffect, useState } from 'react';
import * as Clipboard from 'expo-clipboard';
import {
  View,
  StyleSheet,
  Text,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { Typography } from '../constants/typography';
import { Spacing } from '../constants/spacing';
import { AppTheme } from '../constants/theme';
import { useTheme } from '../components/ThemeProvider';
import { cryptoService, CRYPTO_NETWORKS, type CryptoNetwork } from '../services/crypto.service';
import QrCodeView from '../components/QrCodeView';

const MONO = 'monospace';

/**
 * Deposit as its own screen, matching the same own-screen navigation
 * pattern Buy, Sell, and Withdraw already use. A single step -- pick
 * network, generate address -- so no multi-step structure is needed here.
 * Owner decision, 2026-09-05.
 */
export default function CryptoDepositScreen({ navigation }: { navigation: any }) {
  const { theme } = useTheme();
  const styles = createStyles(theme);

  // Reached straight from Home's action row now, not via CryptoScreen's own
  // tab gate — so this screen needs its own service-enabled check rather
  // than trusting a caller that no longer runs it first. Deposit doesn't
  // require KYC (only Buy/Sell do), matching CryptoScreen's existing gate.
  const [serviceEnabled, setServiceEnabled] = useState(true);
  useFocusEffect(
    useCallback(() => {
      cryptoService.isEnabled().then(setServiceEnabled).catch(() => {});
    }, []),
  );

  const [depositNetwork, setDepositNetwork] = useState<CryptoNetwork>('TRC20');
  const [depositAddress, setDepositAddress] = useState<string | null>(null);
  const [depositLoading, setDepositLoading] = useState(false);
  const [depositError, setDepositError] = useState<string | null>(null);
  const [addressCopied, setAddressCopied] = useState(false);

  // Any network change invalidates whatever address is on screen — never
  // show a TRC20 address after the user switched to BEP20.
  useEffect(() => {
    setDepositAddress(null);
    setDepositError(null);
    setAddressCopied(false);
  }, [depositNetwork]);

  const handleGenerateDepositAddress = useCallback(async () => {
    setDepositLoading(true);
    setDepositError(null);
    const result = await cryptoService.getDepositAddress(depositNetwork);
    setDepositLoading(false);
    if (result.success && result.address) {
      setDepositAddress(result.address);
    } else {
      setDepositError(result.error || 'Could not generate a deposit address.');
    }
  }, [depositNetwork]);

  const handleCopyDepositAddress = useCallback(async () => {
    if (!depositAddress) return;
    try {
      await Clipboard.setStringAsync(depositAddress);
      setAddressCopied(true);
      setTimeout(() => setAddressCopied(false), 2000);
    } catch {
      Alert.alert('Copy address', 'Could not copy the address. Please try again.');
    }
  }, [depositAddress]);

  if (!serviceEnabled) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <View style={styles.header}>
          <TouchableOpacity onPress={navigation.goBack} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Ionicons name="chevron-back" size={24} color={theme.ink} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Deposit Crypto</Text>
          <View style={{ width: 24 }} />
        </View>
        <View style={styles.centerFill}>
          <Ionicons name="logo-bitcoin" size={40} color={theme.inkFaint} />
          <Text style={styles.centerTitle}>Crypto is currently unavailable</Text>
          <Text style={styles.centerSubtitle}>We'll let you know as soon as it's back.</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={navigation.goBack} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Ionicons name="chevron-back" size={24} color={theme.ink} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Deposit Crypto</Text>
        <View style={{ width: 24 }} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.hintText}>
          Bring USDT you already hold on Binance, Bybit, or another exchange into your own crypto account here.
        </Text>

        <Text style={styles.label}>Network</Text>
        <View style={styles.networkRow}>
          {CRYPTO_NETWORKS.map((n) => (
            <TouchableOpacity
              key={n.key}
              style={[styles.networkChip, depositNetwork === n.key && styles.networkChipSelected]}
              onPress={() => setDepositNetwork(n.key)}
            >
              <Text style={[styles.networkChipText, depositNetwork === n.key && styles.networkChipTextSelected]}>
                {n.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {depositAddress ? (
          <View style={styles.confirmBox}>
            <View style={styles.qrCard}>
              <QrCodeView value={depositAddress} size={160} />
            </View>
            <Text style={styles.depositAddressText} selectable>{depositAddress}</Text>
            <TouchableOpacity style={styles.copyAddressButton} onPress={handleCopyDepositAddress}>
              <Text style={styles.copyAddressButtonText}>{addressCopied ? 'Copied ✓' : 'Copy Address'}</Text>
            </TouchableOpacity>
            <Text style={styles.confirmWarning}>
              Only send USDT on {depositNetwork} to this address. Sending on the wrong network, or any other
              asset, cannot be recovered.
            </Text>
          </View>
        ) : (
          <TouchableOpacity
            style={[styles.primaryButton, depositLoading && styles.primaryButtonDisabled]}
            onPress={handleGenerateDepositAddress}
            disabled={depositLoading}
          >
            {depositLoading ? (
              <ActivityIndicator color={theme.background} />
            ) : (
              <Text style={styles.primaryButtonText}>Generate Deposit Address</Text>
            )}
          </TouchableOpacity>
        )}
        {depositError && <Text style={styles.errorText}>{depositError}</Text>}
      </ScrollView>
    </SafeAreaView>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.background },
    centerFill: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: Spacing.L },
    centerTitle: { ...Typography.CARD_TITLE, color: theme.ink, marginTop: Spacing.M, textAlign: 'center' },
    centerSubtitle: { ...Typography.BODY, color: theme.inkMuted, marginTop: Spacing.S, textAlign: 'center' },
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
    content: { paddingHorizontal: Spacing.SCREEN_PADDING, paddingVertical: Spacing.M, paddingBottom: 60 },

    hintText: { ...Typography.CAPTION, color: theme.inkMuted, marginTop: Spacing.M },
    label: { ...Typography.SECTION_HEADING, color: theme.ink, marginTop: Spacing.M, marginBottom: Spacing.M },
    errorText: { ...Typography.ERROR, color: theme.down, marginTop: Spacing.S },

    networkRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.S },
    networkChip: {
      paddingHorizontal: Spacing.M,
      paddingVertical: Spacing.S,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: theme.hairline,
    },
    networkChipSelected: { backgroundColor: theme.brandSoft, borderColor: theme.brand },
    networkChipText: { ...Typography.CAPTION, color: theme.inkMuted, fontWeight: '600' },
    networkChipTextSelected: { color: theme.brand },

    qrCard: {
      alignSelf: 'center',
      backgroundColor: theme.ink,
      borderWidth: 1,
      borderColor: theme.hairline,
      borderRadius: 12,
      padding: Spacing.M,
      marginBottom: Spacing.M,
    },
    depositAddressText: { ...Typography.BODY, fontFamily: MONO, color: theme.ink, textAlign: 'center', marginBottom: Spacing.M },
    copyAddressButton: {
      height: Spacing.BUTTON_HEIGHT_PRIMARY,
      borderRadius: Spacing.BUTTON_RADIUS,
      borderWidth: 1,
      borderColor: theme.brand,
      justifyContent: 'center',
      alignItems: 'center',
    },
    copyAddressButtonText: { ...Typography.BUTTON_TEXT, color: theme.brand },

    confirmBox: {
      backgroundColor: theme.surfaceRaised,
      borderWidth: 1,
      borderColor: theme.hairline,
      borderRadius: Spacing.CARD_RADIUS,
      padding: Spacing.CARD_PADDING,
      marginTop: Spacing.L,
    },
    confirmWarning: { ...Typography.CAPTION, color: theme.gold, marginTop: Spacing.S },

    primaryButton: {
      height: Spacing.BUTTON_HEIGHT_PRIMARY,
      backgroundColor: theme.brand,
      borderRadius: Spacing.BUTTON_RADIUS,
      justifyContent: 'center',
      alignItems: 'center',
      marginTop: Spacing.L,
    },
    primaryButtonDisabled: { opacity: 0.4 },
    primaryButtonText: { ...Typography.BUTTON_TEXT, color: theme.background },
  });
}
