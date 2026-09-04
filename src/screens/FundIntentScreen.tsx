import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { Typography } from '../constants/typography';
import { Spacing } from '../constants/spacing';
import { AppTheme } from '../constants/theme';
import { useTheme } from '../components/ThemeProvider';

type Step = 'choose' | 'crypto_explain';

/**
 * Sits between Home's "Fund Wallet" button and the real WalletFunding
 * screen. People kept tapping Fund Wallet meaning to buy crypto, funding
 * the wallet, and then finding the money couldn't be used for it -- the
 * always-visible nudge card on WalletFunding itself wasn't stopping this,
 * so the choice is asked up front instead, before any wallet-funding UI is
 * even shown. Owner decision, 2026-09-04.
 */
export default function FundIntentScreen({ navigation }: { navigation: any }) {
  const { theme } = useTheme();
  const styles = createStyles(theme);
  const [step, setStep] = useState<Step>('choose');

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => (step === 'crypto_explain' ? setStep('choose') : navigation.goBack())}
        >
          <Text style={styles.backText}>{'<'}</Text>
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {step === 'choose' ? (
          <>
            <Text style={styles.title}>What are you funding for?</Text>

            <TouchableOpacity
              style={styles.optionCard}
              activeOpacity={0.7}
              onPress={() => navigation.navigate('WalletFunding')}
            >
              <Ionicons name="flash-outline" size={24} color={theme.brand} />
              <View style={styles.optionCopy}>
                <Text style={styles.optionTitle}>Airtime, data, bills and transfers</Text>
                <Text style={styles.optionSubtitle}>Add money to your wallet to pay for these</Text>
              </View>
              <Ionicons name="chevron-forward" size={20} color={theme.inkFaint} />
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.optionCard}
              activeOpacity={0.7}
              onPress={() => setStep('crypto_explain')}
            >
              <Ionicons name="logo-bitcoin" size={24} color={theme.brand} />
              <View style={styles.optionCopy}>
                <Text style={styles.optionTitle}>Buying crypto</Text>
                <Text style={styles.optionSubtitle}>This does not use your wallet</Text>
              </View>
              <Ionicons name="chevron-forward" size={20} color={theme.inkFaint} />
            </TouchableOpacity>
          </>
        ) : (
          <>
            <Text style={styles.title}>Crypto is paid by bank transfer</Text>
            <Text style={styles.explainBody}>
              You don't need to fund your wallet for this. On the next screen you'll get a bank
              account to transfer into, and your crypto arrives directly there.
            </Text>
            <TouchableOpacity
              style={styles.primaryButton}
              activeOpacity={0.85}
              onPress={() => navigation.navigate('Crypto')}
            >
              <Text style={styles.primaryButtonText}>Continue to buy crypto</Text>
            </TouchableOpacity>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    safeArea: {
      flex: 1,
      backgroundColor: theme.background,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: Spacing.SCREEN_PADDING,
      paddingTop: Spacing.S,
      paddingBottom: Spacing.XS,
    },
    backButton: {
      width: 48,
      height: 48,
      justifyContent: 'center',
      alignItems: 'center',
    },
    backText: {
      fontSize: 28,
      fontWeight: '600',
      color: theme.ink,
    },
    content: {
      paddingHorizontal: Spacing.SCREEN_PADDING,
      paddingBottom: Spacing.XL,
    },
    title: {
      ...Typography.SCREEN_TITLE,
      color: theme.ink,
      marginTop: Spacing.S,
      marginBottom: Spacing.L,
    },
    optionCard: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Spacing.M,
      backgroundColor: theme.surface,
      borderWidth: Spacing.INPUT_BORDER_WIDTH,
      borderColor: theme.border,
      borderRadius: Spacing.CARD_RADIUS,
      padding: Spacing.CARD_PADDING,
      marginBottom: Spacing.M,
    },
    optionCopy: {
      flex: 1,
    },
    optionTitle: {
      ...Typography.BODY,
      fontWeight: '600',
      color: theme.ink,
    },
    optionSubtitle: {
      ...Typography.CAPTION,
      color: theme.inkMuted,
      marginTop: 2,
    },
    explainBody: {
      ...Typography.BODY,
      color: theme.inkMuted,
      lineHeight: 22,
      marginBottom: Spacing.XL,
    },
    primaryButton: {
      height: Spacing.BUTTON_HEIGHT_PRIMARY,
      backgroundColor: theme.brand,
      borderRadius: Spacing.BUTTON_RADIUS,
      justifyContent: 'center',
      alignItems: 'center',
    },
    primaryButtonText: {
      ...Typography.BUTTON_TEXT,
      color: theme.onBrand,
    },
  });
}
