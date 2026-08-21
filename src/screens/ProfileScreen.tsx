import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  StatusBar,
  Image,
  Alert,
  Linking,
  Keyboard,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { AppTheme } from '../constants/theme';
import { useTheme } from '../components/ThemeProvider';
import { Spacing } from '../constants/spacing';
import { formatNaira } from '../utils/formatCurrency';
import { supabase } from '../lib/supabase';
import { withTimeout } from '../utils/network';
import { walletService } from '../services/wallet.service';
import { kycService } from '../services/kyc.service';
import { SUPPORT_EMAIL } from './LegalDocumentScreen';
import { supportWhatsAppNumber, supportWhatsAppUrl } from '../services/appSettings.service';

const ProfileScreen = ({ navigation }: any) => {
  const { theme } = useTheme();
  const styles = createStyles(theme);
  const [userName, setUserName] = useState('User');
  const [userEmail, setUserEmail] = useState('');
  const [userPhone, setUserPhone] = useState('');
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [totalTransactions, setTotalTransactions] = useState(0);
  const [totalSpent, setTotalSpent] = useState(0);
  const [kycVerified, setKycVerified] = useState(false);

  // Re-fetches every time this screen regains focus (not just on first
  // mount) — otherwise returning here after changing your email/phone in
  // Edit Profile still shows the stale value from when Profile first loaded.
  useFocusEffect(
    useCallback(() => {
      loadUserInfo();
      loadStats();
      loadKycStatus();
    }, []),
  );

  const loadKycStatus = async () => {
    const status = await kycService.getStatus();
    setKycVerified(status.verified);
  };

  const loadUserInfo = async () => {
    try {
      const { data: { user } } = await withTimeout(supabase.auth.getUser());
      if (user) {
        const fullName = user.user_metadata?.full_name
          || user.user_metadata?.name
          || user.email?.split('@')[0]
          || 'User';
        setUserName(fullName);
        setUserEmail(user.email || '');
        setUserPhone(user.phone || user.user_metadata?.phone || '');
        setAvatarUrl(user.user_metadata?.avatar_url || null);
      }
    } catch (error) {
      // silent
    }
  };

  const loadStats = async () => {
    try {
      const summary = await walletService.getTransactionSummary();
      if (summary.success) {
        setTotalTransactions(summary.totalTransactions ?? 0);
        setTotalSpent(summary.totalSpent ?? 0);
      }
    } catch (error) {
      // silent
    }
  };

  // wa.me works whether or not WhatsApp is installed (falls back to the
  // Play Store / WhatsApp Web), so no need to check canOpenURL first. The
  // number is owner-editable (app_settings, migration 131) — read at press
  // time rather than captured, so a mid-session change is used immediately.
  const handleOpenSupport = () => {
    Linking.openURL(supportWhatsAppUrl()).catch(() =>
      Alert.alert('Could not open WhatsApp', 'Please make sure WhatsApp is installed.'),
    );
  };

  const handleDeleteAccount = () => {
    Alert.alert(
      'Delete Account',
      `To delete your account, please contact us with your registered email and phone number and we'll process your request promptly.\n\nWhatsApp: +${supportWhatsAppNumber()}\nEmail: ${SUPPORT_EMAIL}`,
      [
        { text: 'Contact via WhatsApp', onPress: handleOpenSupport },
        { text: 'Cancel', style: 'cancel' },
      ],
    );
  };

  const links: { label: string; icon: keyof typeof Ionicons.glyphMap; screen: string | null; params?: object; onPress?: () => void; badge?: string }[] = [
    { label: 'Edit Profile', icon: 'create-outline', screen: 'EditProfile' },
    { label: 'Identity Verification (KYC)', icon: 'shield-checkmark-outline', screen: 'Kyc', badge: kycVerified ? 'Verified' : 'Not Verified' },
    { label: 'Contact Support', icon: 'logo-whatsapp', screen: null, onPress: handleOpenSupport },
    { label: 'Privacy Policy', icon: 'lock-closed-outline', screen: 'LegalDocument', params: { type: 'privacy' } },
    { label: 'Terms of Service', icon: 'document-text-outline', screen: 'LegalDocument', params: { type: 'terms' } },
    { label: 'Settings', icon: 'settings-outline', screen: 'Settings' },
  ];

  const formatJoinDate = () => {
    const now = new Date();
    const months = ['January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'];
    return `Member since ${months[now.getMonth()]} ${now.getFullYear()}`;
  };

  const maskedPhone = userPhone
    ? userPhone.replace(/(\+234)(\d{3})(\d{4})(\d{4})/, '$1 *** *** $4')
    : '';

  return (
    <SafeAreaView edges={['top']} style={styles.container}>
      <StatusBar barStyle={theme.mode === 'dark' ? 'light-content' : 'dark-content'} backgroundColor={theme.background} />

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => { Keyboard.dismiss(); navigation.goBack(); }}
          activeOpacity={0.7}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Text style={styles.backButtonText}>{'‹'}</Text>
        </TouchableOpacity>

        {/* Profile Header */}
        <View style={styles.header}>
          <View style={styles.avatarContainer}>
            {avatarUrl ? (
              <Image source={{ uri: avatarUrl }} style={styles.avatarImage} />
            ) : (
              <View style={styles.avatar}>
                <Text style={styles.avatarText}>{userName.charAt(0).toUpperCase()}</Text>
              </View>
            )}
          </View>
          <Text style={styles.userName}>{userName}</Text>
          {maskedPhone ? <Text style={styles.phoneNumber}>{maskedPhone}</Text> : null}
          {userEmail ? <Text style={styles.emailText}>{userEmail}</Text> : null}
          <Text style={styles.memberSince}>{formatJoinDate()}</Text>
        </View>

        {/* Stats Row */}
        <View style={styles.statsRow}>
          <View style={styles.statItem}>
            <Text style={styles.statValue}>{totalTransactions}</Text>
            <Text style={styles.statLabel}>Transactions</Text>
          </View>
          <View style={styles.statDivider} />
          <View style={styles.statItem}>
            <Text style={styles.statValue}>{formatNaira(totalSpent)}</Text>
            <Text style={styles.statLabel}>Total Spent</Text>
          </View>
        </View>

        {/* Quick Links Section */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Quick Links</Text>
          <View style={styles.linksContainer}>
            {links.map((link, index) => (
              <TouchableOpacity
                key={index}
                style={[
                  styles.linkItem,
                  index < links.length - 1 && styles.linkItemBorder,
                ]}
                onPress={() => {
                  if (link.onPress) {
                    link.onPress();
                  } else if (link.screen) {
                    navigation.navigate(link.screen, link.params);
                  }
                }}
                activeOpacity={0.7}
              >
                <View style={styles.linkLeft}>
                  <Ionicons name={link.icon} size={20} color={theme.brand} style={styles.linkIcon} />
                  <Text style={styles.linkLabel}>{link.label}</Text>
                </View>
                <View style={styles.linkRight}>
                  {link.badge && (
                    <View style={[styles.kycBadge, link.badge === 'Verified' && styles.kycBadgeVerified]}>
                      <Text style={[styles.kycBadgeText, link.badge === 'Verified' && styles.kycBadgeTextVerified]}>
                        {link.badge}
                      </Text>
                    </View>
                  )}
                  <Text style={styles.linkChevron}>{'>'}</Text>
                </View>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* Danger Zone */}
        <TouchableOpacity style={styles.deleteAccountButton} onPress={handleDeleteAccount} activeOpacity={0.7}>
          <Text style={styles.deleteAccountText}>Delete Account</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
};

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.background,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: Spacing.SCREEN_PADDING,
    paddingBottom: Spacing.XL,
  },
  backButton: {
    width: 44,
    height: 44,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: Spacing.S,
  },
  backButtonText: {
    fontSize: 28,
    fontWeight: '600',
    color: theme.ink,
  },
  header: {
    alignItems: 'center',
    marginTop: Spacing.M,
    marginBottom: Spacing.L,
  },
  avatarContainer: {
    position: 'relative',
    marginBottom: Spacing.M,
  },
  avatar: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: theme.brand,
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarText: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 36,
    color: '#FFFFFF',
  },
  avatarImage: {
    width: 96,
    height: 96,
    borderRadius: 48,
    borderWidth: 3,
    borderColor: theme.brand,
  },
  cameraIcon: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: theme.brand,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 3,
    borderColor: '#FFFFFF',
  },
  cameraIconText: {
    fontSize: 14,
  },
  userName: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 22,
    color: theme.ink,
    marginBottom: 4,
  },
  phoneNumber: {
    fontSize: 15,
    color: theme.inkMuted,
    marginBottom: 2,
  },
  emailText: {
    fontSize: 13,
    color: theme.inkMuted,
    marginBottom: 4,
  },
  memberSince: {
    fontSize: 12,
    color: theme.inkMuted,
  },
  statsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: theme.surfaceRaised,
    borderRadius: 12,
    padding: 16,
    marginBottom: 24,
  },
  statItem: {
    flex: 1,
    alignItems: 'center',
  },
  statDivider: {
    width: 1,
    height: 32,
    backgroundColor: theme.border,
    marginHorizontal: 12,
  },
  statValue: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 18,
    color: theme.ink,
    marginBottom: 4,
  },
  statLabel: {
    fontSize: 12,
    color: theme.inkMuted,
    textAlign: 'center',
  },
  section: {
    marginBottom: 24,
  },
  sectionTitle: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 16,
    color: theme.ink,
    marginBottom: 12,
  },
  linksContainer: {
    backgroundColor: theme.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.border,
  },
  linkItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 16,
    paddingHorizontal: 16,
  },
  linkItemBorder: {
    borderBottomWidth: 1,
    borderBottomColor: theme.border,
  },
  linkLeft: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  linkIcon: {
    fontSize: 20,
    marginRight: 16,
  },
  linkLabel: {
    fontSize: 15,
    color: theme.ink,
  },
  linkChevron: {
    fontSize: 18,
    color: theme.inkMuted,
  },
  linkRight: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  kycBadge: {
    backgroundColor: theme.goldSoft,
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 3,
    marginRight: 8,
  },
  kycBadgeVerified: {
    backgroundColor: theme.brandSoft,
  },
  kycBadgeText: {
    fontSize: 10,
    fontWeight: '700',
    color: theme.gold,
  },
  kycBadgeTextVerified: {
    color: theme.brand,
  },
  referralSection: {
    alignItems: 'center',
    marginTop: 8,
    marginBottom: 32,
  },
  referralButton: {
    backgroundColor: theme.brand,
    borderRadius: 12,
    height: 52,
    width: '100%',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 12,
  },
  referralButtonText: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 16,
    color: '#FFFFFF',
  },
  referralCodeContainer: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  referralCodeLabel: {
    fontSize: 13,
    color: theme.inkMuted,
    marginRight: 8,
  },
  referralCode: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 15,
    color: theme.ink,
  },
  deleteAccountButton: {
    alignItems: 'center',
    paddingVertical: Spacing.M,
    marginTop: Spacing.S,
  },
  deleteAccountText: {
    fontSize: 14,
    fontWeight: '600',
    color: theme.down,
  },
  });
}

export default ProfileScreen;
