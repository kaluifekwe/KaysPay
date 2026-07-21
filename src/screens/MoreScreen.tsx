import React, { useCallback } from 'react';
import { View, StyleSheet, Text, SafeAreaView, ScrollView, TouchableOpacity, Alert } from 'react-native';
import { Colors } from '../constants/colors';
import { Typography } from '../constants/typography';
import { Spacing } from '../constants/spacing';
import { authService } from '../services/auth.service';

interface Row {
  icon: string;
  label: string;
  screen?: string;
  params?: any;
}

// The "Account" tab — a hub linking to the account/settings screens that
// already exist, plus log out. Every target is a registered MainStack route,
// reached from this tab by letting navigate() bubble up.
const SECTIONS: { title: string; rows: Row[] }[] = [
  {
    title: 'Account',
    rows: [
      { icon: '👤', label: 'Profile', screen: 'Profile' },
      { icon: '🪪', label: 'Verification (KYC)', screen: 'Kyc' },
      { icon: '🔑', label: 'Change PIN', screen: 'ChangePin' },
      { icon: '⚙️', label: 'Settings', screen: 'Settings' },
    ],
  },
  {
    title: 'Activity',
    rows: [
      { icon: '🧾', label: 'Transaction History', screen: 'TransactionHistory' },
      { icon: '🔔', label: 'Notifications', screen: 'Notifications' },
    ],
  },
  {
    title: 'Legal',
    rows: [
      { icon: '🔒', label: 'Privacy Policy', screen: 'LegalDocument', params: { type: 'privacy' } },
      { icon: '📄', label: 'Terms of Service', screen: 'LegalDocument', params: { type: 'terms' } },
    ],
  },
];

export default function MoreScreen({ navigation }: any) {
  const handleLogout = useCallback(() => {
    Alert.alert('Log Out', 'Are you sure you want to log out?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Log Out',
        style: 'destructive',
        onPress: async () => {
          try {
            await authService.signOut();
          } catch {
            /* auth state listener handles the redirect regardless */
          }
        },
      },
    ]);
  }, []);

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.screenTitle}>Account</Text>
      </View>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {SECTIONS.map((section) => (
          <View key={section.title} style={styles.section}>
            <Text style={styles.sectionTitle}>{section.title}</Text>
            <View style={styles.card}>
              {section.rows.map((row, i) => (
                <TouchableOpacity
                  key={row.label}
                  style={[styles.row, i < section.rows.length - 1 && styles.rowBorder]}
                  activeOpacity={0.6}
                  onPress={() => row.screen && navigation.navigate(row.screen, row.params)}
                >
                  <Text style={styles.rowIcon}>{row.icon}</Text>
                  <Text style={styles.rowLabel}>{row.label}</Text>
                  <Text style={styles.rowChevron}>{'›'}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        ))}

        <TouchableOpacity style={styles.logout} activeOpacity={0.7} onPress={handleLogout}>
          <Text style={styles.logoutText}>Log Out</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.WHITE },
  header: {
    paddingHorizontal: Spacing.SCREEN_PADDING,
    paddingVertical: Spacing.M,
    borderBottomWidth: 1,
    borderBottomColor: Colors.BORDER,
  },
  screenTitle: { ...Typography.SCREEN_TITLE, color: Colors.DARK },
  content: { padding: Spacing.SCREEN_PADDING, paddingBottom: Spacing.XL },
  section: { marginBottom: Spacing.L },
  sectionTitle: {
    ...Typography.CAPTION,
    color: Colors.GRAY,
    fontWeight: '700',
    textTransform: 'uppercase',
    marginBottom: Spacing.S,
    marginLeft: Spacing.XS,
  },
  card: {
    backgroundColor: Colors.WHITE,
    borderWidth: 1,
    borderColor: Colors.BORDER,
    borderRadius: Spacing.CARD_RADIUS,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: Spacing.M,
    paddingHorizontal: Spacing.M,
  },
  rowBorder: { borderBottomWidth: 1, borderBottomColor: Colors.BORDER },
  rowIcon: { fontSize: 20, marginRight: Spacing.M },
  rowLabel: { ...Typography.BODY, color: Colors.DARK, flex: 1 },
  rowChevron: { fontSize: 22, color: Colors.GRAY },
  logout: {
    height: Spacing.BUTTON_HEIGHT_PRIMARY,
    borderRadius: Spacing.BUTTON_RADIUS,
    borderWidth: 1,
    borderColor: Colors.ERROR,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: Spacing.M,
  },
  logoutText: { ...Typography.BUTTON_TEXT, color: Colors.ERROR },
});
