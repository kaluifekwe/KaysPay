import React, { useState, useEffect } from 'react';
import {
  View,
  StyleSheet,
  Text,
  SafeAreaView,
  ScrollView,
  TouchableOpacity,
  Switch,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { Colors } from '../constants/colors';
import { Spacing } from '../constants/spacing';
import { Typography } from '../constants/typography';
import { formatNaira } from '../utils/formatCurrency';
import * as LocalAuthentication from 'expo-local-authentication';
import { authService } from '../services/auth.service';
import { useTransactionAuth } from '../components/TransactionAuthProvider';

interface SettingsScreenProps {
  navigation: any;
}

interface SettingsItem {
  icon: string;
  label: string;
  value?: string;
  hasToggle?: boolean;
  toggleValue?: boolean;
  onPress?: () => void;
  onToggle?: (value: boolean) => void;
  isDestructive?: boolean;
}

interface SettingsSection {
  title: string;
  items: SettingsItem[];
}

export default function SettingsScreen({ navigation }: SettingsScreenProps) {
  const { authorize } = useTransactionAuth();
  const [biometricEnabled, setBiometricEnabled] = useState(false);
  const [twoFactorEnabled, setTwoFactorEnabled] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  useEffect(() => {
    // Accounts that enabled biometric before the PIN/biometric rework have
    // the preference flag set but no PIN actually stored in the keychain —
    // show the toggle as OFF for those so re-enabling prompts for the PIN
    // again instead of silently doing nothing at transaction time.
    (async () => {
      const [enabled, hasPin] = await Promise.all([
        authService.isBiometricEnabled(),
        authService.hasBiometricPin(),
      ]);
      setBiometricEnabled(enabled && hasPin);
    })();
  }, []);

  const handleBiometricToggle = async (value: boolean) => {
    if (value) {
      const [hasHardware, enrolled] = await Promise.all([
        LocalAuthentication.hasHardwareAsync(),
        LocalAuthentication.isEnrolledAsync(),
      ]);
      if (!hasHardware || !enrolled) {
        Alert.alert(
          'Biometric Unavailable',
          'Set up a fingerprint or face unlock on your device first.',
        );
        return;
      }

      // Biometric enable isn't itself enabled yet, so the PIN pad (not the
      // biometric fast-path) will always be what runs here — this is how we
      // get the raw PIN needed to store it behind the biometric-gated
      // keychain entry (see TransactionAuthProvider / auth.service.ts).
      const result = await authorize({
        title: 'Confirm your PIN',
        subtitle: 'Enter your PIN to enable biometric authorization',
      });
      if (!result) return;
      await authService.saveBiometricPin(result.pin);
    }
    setBiometricEnabled(value);
    await authService.saveBiometric(value);
  };

  const handleLogout = () => {
    Alert.alert(
      'Log Out',
      'Are you sure you want to log out?',
      [
        {
          text: 'Cancel',
          style: 'cancel',
        },
        {
          text: 'Log Out',
          style: 'destructive',
          onPress: async () => {
            if (loggingOut) return;
            setLoggingOut(true);
            try {
              await authService.signOut();
              // AppNavigator listens for the auth state change and swaps to
              // the Auth stack itself — no manual navigation needed here.
            } catch (error) {
              setLoggingOut(false);
              Alert.alert('Error', 'Could not log out. Please try again.');
            }
          },
        },
      ],
      { cancelable: false }
    );
  };

  const sections: SettingsSection[] = [
    {
      title: 'Account',
      items: [
        {
          icon: '📱',
          label: 'Phone Number',
          value: '0803 *** 4567',
          onPress: () => {},
        },
        {
          icon: '📧',
          label: 'Email',
          value: 'user@email.com',
          onPress: () => {},
        },
        {
          icon: '🔐',
          label: 'Change PIN',
          onPress: () => navigation.navigate('ChangePin'),
        },
      ],
    },
    {
      title: 'Security',
      items: [
        {
          icon: '👆',
          label: 'Biometric Login',
          hasToggle: true,
          toggleValue: biometricEnabled,
          onToggle: handleBiometricToggle,
        },
        {
          icon: '🛡️',
          label: 'Two-Factor Authentication',
          hasToggle: true,
          toggleValue: twoFactorEnabled,
          onToggle: setTwoFactorEnabled,
        },
      ],
    },
    {
      title: 'Preferences',
      items: [
        {
          icon: '💰',
          label: 'Currency',
          value: 'NGN',
          onPress: () => {},
        },
        {
          icon: '🌍',
          label: 'Language',
          value: 'English',
          onPress: () => {},
        },
        {
          icon: '🎨',
          label: 'Theme',
          value: 'Light',
          onPress: () => {},
        },
      ],
    },
    {
      title: 'About',
      items: [
        {
          icon: 'ℹ️',
          label: 'App Version',
          value: '1.0.0',
        },
      ],
    },
  ];

  const renderSettingsItem = (item: SettingsItem, index: number, isLast: boolean) => (
    <TouchableOpacity
      key={item.label}
      style={[
        styles.settingsItem,
        isLast && styles.settingsItemLast,
      ]}
      onPress={item.onPress}
      disabled={item.hasToggle}
      activeOpacity={item.hasToggle ? 1 : 0.7}
    >
      <View style={styles.settingsItemLeft}>
        <Text style={styles.settingsItemIcon}>{item.icon}</Text>
        <Text
          style={[
            styles.settingsItemLabel,
            item.isDestructive && styles.destructiveText,
          ]}
        >
          {item.label}
        </Text>
      </View>
      <View style={styles.settingsItemRight}>
        {item.hasToggle ? (
          <Switch
            value={item.toggleValue}
            onValueChange={item.onToggle}
            trackColor={{ false: Colors.LIGHT_GRAY, true: Colors.GREEN_LIGHT }}
            thumbColor={item.toggleValue ? Colors.GREEN : Colors.GRAY}
            ios_backgroundColor={Colors.LIGHT_GRAY}
          />
        ) : (
          <>
            {item.value && (
              <Text style={styles.settingsItemValue}>{item.value}</Text>
            )}
            {item.onPress && (
              <Text style={styles.settingsItemChevron}>›</Text>
            )}
          </>
        )}
      </View>
    </TouchableOpacity>
  );

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => navigation.goBack()}
          activeOpacity={0.7}
        >
          <Text style={styles.backButtonText}>‹</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Settings</Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {sections.map((section) => (
          <View key={section.title} style={styles.section}>
            <Text style={styles.sectionTitle}>{section.title}</Text>
            <View style={styles.sectionContent}>
              {section.items.map((item, index) =>
                renderSettingsItem(item, index, index === section.items.length - 1)
              )}
            </View>
          </View>
        ))}

        <TouchableOpacity
          style={styles.logoutButton}
          onPress={handleLogout}
          activeOpacity={0.8}
          disabled={loggingOut}
        >
          {loggingOut ? (
            <ActivityIndicator color={Colors.WHITE} size="small" />
          ) : (
            <Text style={styles.logoutButtonText}>Log Out</Text>
          )}
        </TouchableOpacity>

        <View style={styles.bottomSpacer} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.WHITE,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.L,
    paddingVertical: Spacing.M,
    borderBottomWidth: 1,
    borderBottomColor: Colors.BORDER,
  },
  backButton: {
    width: 48,
    height: 48,
    justifyContent: 'center',
    alignItems: 'center',
  },
  backButtonText: {
    fontSize: 28,
    fontWeight: '600',
    color: Colors.DARK,
  },
  headerTitle: {
    ...Typography.SCREEN_TITLE,
    flex: 1,
    textAlign: 'center',
  },
  headerSpacer: {
    width: 48,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    padding: Spacing.SCREEN_PADDING,
  },
  section: {
    marginBottom: Spacing.XL,
  },
  sectionTitle: {
    ...Typography.SECTION_HEADING,
    color: Colors.GREEN,
    marginBottom: Spacing.M,
  },
  sectionContent: {
    backgroundColor: Colors.LIGHT_GRAY,
    borderRadius: Spacing.BUTTON_RADIUS,
    overflow: 'hidden',
  },
  settingsItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: Spacing.L,
    paddingVertical: Spacing.L,
    borderBottomWidth: 1,
    borderBottomColor: Colors.BORDER,
  },
  settingsItemLast: {
    borderBottomWidth: 0,
  },
  settingsItemLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  settingsItemIcon: {
    fontSize: 20,
    marginRight: Spacing.M,
  },
  settingsItemLabel: {
    ...Typography.BODY,
    color: Colors.DARK,
  },
  settingsItemRight: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  settingsItemValue: {
    ...Typography.BODY,
    color: Colors.GRAY,
    marginRight: Spacing.S,
  },
  settingsItemChevron: {
    fontSize: 20,
    color: Colors.GRAY,
  },
  destructiveText: {
    color: Colors.RED,
  },
  logoutButton: {
    backgroundColor: Colors.RED,
    height: Spacing.BUTTON_HEIGHT_PRIMARY,
    borderRadius: Spacing.BUTTON_RADIUS,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: Spacing.L,
  },
  logoutButtonText: {
    ...Typography.BUTTON_TEXT,
    color: Colors.WHITE,
  },
  bottomSpacer: {
    height: Spacing.XL * 2,
  },
});
