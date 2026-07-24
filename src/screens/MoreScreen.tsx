import React, { useCallback, useState } from 'react';
import { View, StyleSheet, Text, ScrollView, TouchableOpacity, Alert, Image } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { Colors } from '../constants/colors';
import { Typography } from '../constants/typography';
import { Spacing } from '../constants/spacing';
import { authService } from '../services/auth.service';
import { supabase } from '../lib/supabase';

interface Row {
  icon: keyof typeof Ionicons.glyphMap;
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
      { icon: 'person-outline', label: 'Profile', screen: 'Profile' },
      { icon: 'shield-checkmark-outline', label: 'Verification (KYC)', screen: 'Kyc' },
      { icon: 'key-outline', label: 'Change PIN', screen: 'ChangePin' },
      { icon: 'settings-outline', label: 'Settings', screen: 'Settings' },
    ],
  },
  {
    title: 'Activity',
    rows: [
      { icon: 'receipt-outline', label: 'Transaction History', screen: 'TransactionHistory' },
      { icon: 'notifications-outline', label: 'Notifications', screen: 'Notifications' },
    ],
  },
  {
    title: 'Legal',
    rows: [
      { icon: 'lock-closed-outline', label: 'Privacy Policy', screen: 'LegalDocument', params: { type: 'privacy' } },
      { icon: 'document-text-outline', label: 'Terms of Service', screen: 'LegalDocument', params: { type: 'terms' } },
    ],
  },
];

export default function MoreScreen({ navigation }: any) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);

  // Refresh on focus so edits made on the Profile screen show up when the
  // user comes back to this tab.
  useFocusEffect(
    useCallback(() => {
      let active = true;
      (async () => {
        try {
          const { data: { user } } = await supabase.auth.getUser();
          if (!active || !user) return;
          setName(user.user_metadata?.full_name || user.user_metadata?.name || '');
          setEmail(user.email || '');
          setAvatarUrl(user.user_metadata?.avatar_url || null);
        } catch {
          /* leave placeholders */
        }
      })();
      return () => {
        active = false;
      };
    }, []),
  );

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

  const initial = (name || email || '?').trim().charAt(0).toUpperCase();

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.screenTitle}>Account</Text>
      </View>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {/* Profile summary — leads the screen and opens the full Profile */}
        <TouchableOpacity
          style={styles.profileCard}
          activeOpacity={0.6}
          onPress={() => navigation.navigate('Profile')}
        >
          <View style={styles.avatar}>
            {avatarUrl ? (
              <Image source={{ uri: avatarUrl }} style={styles.avatarImg} />
            ) : (
              <Text style={styles.avatarInitial}>{initial}</Text>
            )}
          </View>
          <View style={styles.profileInfo}>
            <Text style={styles.profileName} numberOfLines={1}>
              {name || 'Your Account'}
            </Text>
            {email ? (
              <Text style={styles.profileEmail} numberOfLines={1}>
                {email}
              </Text>
            ) : null}
          </View>
          <Ionicons name="chevron-forward" size={18} color="rgba(255,255,255,0.8)" />
        </TouchableOpacity>

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
                  <Ionicons name={row.icon} size={20} color={Colors.GREEN} style={styles.rowIcon} />
                  <Text style={styles.rowLabel}>{row.label}</Text>
                  <Ionicons name="chevron-forward" size={18} color={Colors.GRAY} />
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
  profileCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.GREEN,
    borderRadius: Spacing.CARD_RADIUS,
    padding: Spacing.M,
    marginBottom: Spacing.L,
  },
  avatar: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: Colors.WHITE,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: Spacing.M,
    overflow: 'hidden',
  },
  avatarImg: { width: 52, height: 52 },
  avatarInitial: { fontSize: 22, fontWeight: '800', color: Colors.GREEN },
  profileInfo: { flex: 1 },
  profileName: { ...Typography.BODY, color: Colors.WHITE, fontWeight: '700', fontSize: 16 },
  profileEmail: { ...Typography.CAPTION, color: Colors.WHITE_80, marginTop: 2 },
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
