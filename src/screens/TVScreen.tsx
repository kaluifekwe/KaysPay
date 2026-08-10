import React, { useMemo } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Colors } from '../constants/colors';
import { Spacing } from '../constants/spacing';
import { Typography } from '../constants/typography';
import ProviderLogo from '../components/ProviderLogo';
import { vtuService, type TVProvider } from '../services/vtu.service';
import { TV_LOGOS } from '../utils/providerLogos';

interface TVScreenProps {
  navigation: {
    goBack: () => void;
    navigate: (screen: string, params?: object) => void;
  };
}

export default function TVScreen({ navigation }: TVScreenProps) {
  const providers = useMemo(() => vtuService.getTVProviders(), []);

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

        <Text style={styles.title}>TV Subscription</Text>
        <Text style={styles.subtitle}>Select your TV provider</Text>

        <View style={styles.providerGrid}>
          {providers.map((provider: TVProvider) => (
            <TouchableOpacity
              key={provider.id}
              style={styles.providerCard}
              activeOpacity={0.7}
              onPress={() => navigation.navigate('TVPay', { provider })}
            >
              <ProviderLogo
                source={TV_LOGOS[provider.id]}
                fallbackLabel={provider.name}
                size={44}
                style={styles.providerLogo}
              />
              <Text style={styles.providerName}>{provider.name}</Text>
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
  providerGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.M },
  providerCard: {
    width: '47%',
    minHeight: 132,
    padding: Spacing.CARD_PADDING,
    borderWidth: 1,
    borderColor: Colors.BORDER,
    borderRadius: Spacing.CARD_RADIUS,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: Colors.WHITE,
  },
  providerLogo: { marginBottom: Spacing.S },
  providerName: { ...Typography.CARD_TITLE, fontSize: 15, textAlign: 'center' },
});
