import React, { useCallback, useState } from 'react';
import {
  View,
  StyleSheet,
  Text,
  ScrollView,
  TouchableOpacity,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { Colors } from '../constants/colors';
import { Typography } from '../constants/typography';
import { Spacing } from '../constants/spacing';
import { vtuService, type ElectricityProvider } from '../services/vtu.service';
import ProviderLogo from '../components/ProviderLogo';
import { ELECTRICITY_LOGOS } from '../utils/providerLogos';

interface BillsScreenProps {
  navigation: {
    goBack: () => void;
    navigate: (screen: string, params?: object) => void;
  };
}

export default function BillsScreen({ navigation }: BillsScreenProps) {
  const [providers, setProviders] = useState<ElectricityProvider[]>(() =>
    vtuService.getElectricityProviders()
  );

  useFocusEffect(
    useCallback(() => {
      let active = true;
      setProviders(vtuService.getElectricityProviders());
      void vtuService.refreshElectricityProviders(true).then((available) => {
        if (active) setProviders(available);
      });
      return () => { active = false; };
    }, [])
  );

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

        <Text style={styles.title}>Pay Electricity Bill</Text>
        <Text style={styles.subtitle}>Select your provider</Text>

        <View style={styles.providerGrid}>
          {providers.map((provider: ElectricityProvider) => (
            <TouchableOpacity
              key={provider.id}
              style={styles.providerCard}
              activeOpacity={0.7}
              onPress={() => navigation.navigate('ElectricityPay', { provider })}
            >
              <ProviderLogo
                source={ELECTRICITY_LOGOS[provider.id]}
                fallbackLabel={provider.name}
                size={40}
                style={styles.providerIconSpacing}
              />
              <Text style={styles.providerName} numberOfLines={2}>
                {provider.name}
              </Text>
              <Text style={styles.providerType}>{provider.type}</Text>
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
    width: '47%',
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
    marginBottom: 2,
  },
  providerType: {
    ...Typography.CAPTION,
    textTransform: 'capitalize',
  },
});
