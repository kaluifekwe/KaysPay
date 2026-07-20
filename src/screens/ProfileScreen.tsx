import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  ScrollView,
  TouchableOpacity,
  StatusBar,
  Image,
  Alert,
  ActivityIndicator,
  Linking,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import * as ImagePicker from 'expo-image-picker';
import { Colors } from '../constants/colors';
import { Spacing } from '../constants/spacing';
import { Typography } from '../constants/typography';
import { formatNaira } from '../utils/formatCurrency';
import { supabase } from '../lib/supabase';
import { walletService } from '../services/wallet.service';
import { kycService } from '../services/kyc.service';
import { SUPPORT_EMAIL } from './LegalDocumentScreen';

const BRAND_GREEN = '#1A5C3A';
const DARK_TEXT = '#0F1A14';
const GRAY_TEXT = '#6B7280';
const WHITE = '#FFFFFF';

const ProfileScreen = ({ navigation }: any) => {
  const [userName, setUserName] = useState('User');
  const [userEmail, setUserEmail] = useState('');
  const [userPhone, setUserPhone] = useState('');
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
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
      const { data: { user } } = await supabase.auth.getUser();
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
      const txResult = await walletService.getRecentTransactions(1000);
      if (txResult.success && txResult.transactions) {
        setTotalTransactions(txResult.transactions.length);
        const spent = txResult.transactions
          .filter((tx) => tx.type !== 'wallet_fund' && tx.type !== 'refund')
          .reduce((sum, tx) => sum + tx.amount_ngn, 0);
        setTotalSpent(spent);
      }
    } catch (error) {
      // silent
    }
  };

  const pickImage = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission needed', 'Please grant camera roll permissions to upload a profile picture.');
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.8,
    });

    if (!result.canceled && result.assets[0]) {
      uploadAvatar(result.assets[0].uri);
    }
  };

  const takePhoto = async () => {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission needed', 'Please grant camera permissions to take a photo.');
      return;
    }

    const result = await ImagePicker.launchCameraAsync({
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.8,
    });

    if (!result.canceled && result.assets[0]) {
      uploadAvatar(result.assets[0].uri);
    }
  };

  const uploadAvatar = async (uri: string) => {
    setUploading(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const response = await fetch(uri);
      const blob = await response.blob();
      const fileExt = uri.split('.').pop() || 'jpg';
      const fileName = `${user.id}/avatar.${fileExt}`;

      const { error: uploadError } = await supabase.storage
        .from('avatars')
        .upload(fileName, blob, {
          contentType: `image/${fileExt}`,
          upsert: true,
        });

      if (uploadError) throw uploadError;

      const { data: urlData } = supabase.storage
        .from('avatars')
        .getPublicUrl(fileName);

      const publicUrl = urlData.publicUrl;

      const { error: updateError } = await supabase.auth.updateUser({
        data: { avatar_url: publicUrl },
      });

      if (updateError) throw updateError;

      setAvatarUrl(publicUrl);
      Alert.alert('Success', 'Profile picture updated!');
    } catch (error: any) {
      Alert.alert('Error', error.message || 'Failed to upload profile picture');
    } finally {
      setUploading(false);
    }
  };

  const handleAvatarPress = () => {
    Alert.alert(
      'Change Profile Picture',
      'Choose an option',
      [
        { text: 'Take Photo', onPress: takePhoto },
        { text: 'Choose from Library', onPress: pickImage },
        { text: 'Cancel', style: 'cancel' },
      ]
    );
  };

  // wa.me works whether or not WhatsApp is installed (falls back to the
  // Play Store / WhatsApp Web), so no need to check canOpenURL first.
  const WHATSAPP_SUPPORT_NUMBER = '2348028387709';
  const handleOpenSupport = () => {
    Linking.openURL(`https://wa.me/${WHATSAPP_SUPPORT_NUMBER}`).catch(() =>
      Alert.alert('Could not open WhatsApp', 'Please make sure WhatsApp is installed.'),
    );
  };

  const handleDeleteAccount = () => {
    Alert.alert(
      'Delete Account',
      `To delete your account, please contact us with your registered email and phone number and we'll process your request promptly.\n\nWhatsApp: +${WHATSAPP_SUPPORT_NUMBER}\nEmail: ${SUPPORT_EMAIL}`,
      [
        { text: 'Contact via WhatsApp', onPress: handleOpenSupport },
        { text: 'Cancel', style: 'cancel' },
      ],
    );
  };

  const links: { label: string; icon: string; screen: string | null; params?: object; onPress?: () => void; badge?: string }[] = [
    { label: 'Edit Profile', icon: '👤', screen: 'EditProfile' },
    { label: 'Identity Verification (KYC)', icon: '🪪', screen: 'Kyc', badge: kycVerified ? 'Verified' : 'Not Verified' },
    { label: 'Transaction History', icon: '📋', screen: 'TransactionHistory' },
    { label: 'Help & Support', icon: '❓', screen: null, onPress: handleOpenSupport },
    { label: 'Privacy Policy', icon: '🔒', screen: 'LegalDocument', params: { type: 'privacy' } },
    { label: 'Terms of Service', icon: '📄', screen: 'LegalDocument', params: { type: 'terms' } },
    { label: 'Settings', icon: '⚙️', screen: 'Settings' },
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
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor={WHITE} />

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => navigation.goBack()}
          activeOpacity={0.7}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Text style={styles.backButtonText}>{'‹'}</Text>
        </TouchableOpacity>

        {/* Profile Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={handleAvatarPress} activeOpacity={0.8}>
            <View style={styles.avatarContainer}>
              {avatarUrl ? (
                <Image source={{ uri: avatarUrl }} style={styles.avatarImage} />
              ) : (
                <View style={styles.avatar}>
                  <Text style={styles.avatarText}>{userName.charAt(0).toUpperCase()}</Text>
                </View>
              )}
              <View style={styles.cameraIcon}>
                {uploading ? (
                  <ActivityIndicator size="small" color={WHITE} />
                ) : (
                  <Text style={styles.cameraIconText}>📷</Text>
                )}
              </View>
            </View>
          </TouchableOpacity>
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
                  <Text style={styles.linkIcon}>{link.icon}</Text>
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

        {/* Referral Code Button */}
        <View style={styles.referralSection}>
          <TouchableOpacity
            style={styles.referralButton}
            activeOpacity={0.8}
          >
            <Text style={styles.referralButtonText}>Share Referral Code</Text>
          </TouchableOpacity>
          <View style={styles.referralCodeContainer}>
            <Text style={styles.referralCodeLabel}>Your Code:</Text>
            <Text style={styles.referralCode}>KAYSPAY-XXXX</Text>
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

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: WHITE,
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
    color: DARK_TEXT,
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
    backgroundColor: BRAND_GREEN,
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarText: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 36,
    color: WHITE,
  },
  avatarImage: {
    width: 96,
    height: 96,
    borderRadius: 48,
    borderWidth: 3,
    borderColor: BRAND_GREEN,
  },
  cameraIcon: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: BRAND_GREEN,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 3,
    borderColor: WHITE,
  },
  cameraIconText: {
    fontSize: 14,
  },
  userName: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 22,
    color: DARK_TEXT,
    marginBottom: 4,
  },
  phoneNumber: {
    fontSize: 15,
    color: GRAY_TEXT,
    marginBottom: 2,
  },
  emailText: {
    fontSize: 13,
    color: GRAY_TEXT,
    marginBottom: 4,
  },
  memberSince: {
    fontSize: 12,
    color: GRAY_TEXT,
  },
  statsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#F3F4F6',
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
    backgroundColor: '#D1D5DB',
    marginHorizontal: 12,
  },
  statValue: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 18,
    color: DARK_TEXT,
    marginBottom: 4,
  },
  statLabel: {
    fontSize: 12,
    color: GRAY_TEXT,
    textAlign: 'center',
  },
  section: {
    marginBottom: 24,
  },
  sectionTitle: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 16,
    color: DARK_TEXT,
    marginBottom: 12,
  },
  linksContainer: {
    backgroundColor: WHITE,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E5E7EB',
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
    borderBottomColor: '#E5E7EB',
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
    color: DARK_TEXT,
  },
  linkChevron: {
    fontSize: 18,
    color: GRAY_TEXT,
  },
  linkRight: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  kycBadge: {
    backgroundColor: '#FEF3C7',
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 3,
    marginRight: 8,
  },
  kycBadgeVerified: {
    backgroundColor: '#D6F0E3',
  },
  kycBadgeText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#B45309',
  },
  kycBadgeTextVerified: {
    color: BRAND_GREEN,
  },
  referralSection: {
    alignItems: 'center',
    marginTop: 8,
    marginBottom: 32,
  },
  referralButton: {
    backgroundColor: BRAND_GREEN,
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
    color: WHITE,
  },
  referralCodeContainer: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  referralCodeLabel: {
    fontSize: 13,
    color: GRAY_TEXT,
    marginRight: 8,
  },
  referralCode: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 15,
    color: DARK_TEXT,
  },
  deleteAccountButton: {
    alignItems: 'center',
    paddingVertical: Spacing.M,
    marginTop: Spacing.S,
  },
  deleteAccountText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#DC2626',
  },
});

export default ProfileScreen;
