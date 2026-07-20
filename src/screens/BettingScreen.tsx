import React, { useMemo } from 'react';
import {
  View,
  StyleSheet,
  Text,
  ScrollView,
  TouchableOpacity,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Colors } from '../constants/colors';
import { Typography } from '../constants/typography';
import { Spacing } from '../constants/spacing';
import { vtuService, type BettingProvider } from '../services/vtu.service';
import ProviderLogo from '../components/ProviderLogo';
import { BETTING_LOGOS } from '../utils/providerLogos';

interface BettingScreenProps {
  navigation: {
    goBack: () => void;
    navigate: (screen: string, params?: object) => void;
  };
}

export default function BettingScreen({ navigation }: BettingScreenProps) {
  const providers = useMemo(() => vtuService.getBettingProviders(), []);

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <TouchableOpacity
          style={styles.backButton}
          activeOpacity={0.6}
          onPress={() => navigation.goBack()}
        >
          <Text style={styles.backText}>{'<'}</Text>
        </TouchableOpacity>

        <Text style={styles.title}>Fund Betting Wallet</Text>
        <Text style={styles.subtitle}>Select a platform</Text>

        <View style={styles.providerGrid}>
          {providers.map((provider: BettingProvider) => (
            <TouchableOpacity
              key={provider.id}
              style={styles.providerCard}
              activeOpacity={0.7}
              onPress={() => navigation.navigate('BettingFund', { provider })}
            >
              <ProviderLogo
                source={BETTING_LOGOS[provider.id]}
                fallbackLabel={provider.name}
                size={40}
                style={styles.providerIconSpacing}
              />
              <Text style={styles.providerName} numberOfLines={2}>
                {provider.name}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.WHITE },
  scrollView: { flex: 1 },
  scrollContent: {
    paddingHorizontal: Spacing.SCREEN_PADDING,
    paddingTop: Spacing.M,
    paddingBottom: Spacing.XL,
  },
  backButton: {
    width: 48,
    height: 48,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: Spacing.M,
  },
  backText: { fontSize: 28, fontWeight: '600', color: Colors.DARK },
  title: { ...Typography.SCREEN_TITLE, marginBottom: Spacing.XS },
  subtitle: { ...Typography.BODY, color: Colors.GRAY, marginBottom: Spacing.L },
  providerGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.M,
  },
  providerCard: {
    width: '30%',
    backgroundColor: Colors.WHITE,
    borderWidth: 1,
    borderColor: Colors.BORDER,
    borderRadius: Spacing.CARD_RADIUS,
    padding: Spacing.CARD_PADDING,
    alignItems: 'center',
  },
  providerIconSpacing: { marginBottom: Spacing.S },
  providerName: {
    ...Typography.BODY,
    fontSize: 12,
    textAlign: 'center',
    color: Colors.DARK,
  },
});
