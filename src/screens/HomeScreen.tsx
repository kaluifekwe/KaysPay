import React, { useState, useEffect } from 'react';
import {
  View,
  StyleSheet,
  Text,
  ScrollView,
  TouchableOpacity,
  FlatList,
  RefreshControl,
  StatusBar,
  Image,
  Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors } from '../constants/colors';
import { Typography } from '../constants/typography';
import { Spacing } from '../constants/spacing';
import { Strings } from '../constants/strings';
import { StorageKeys, storageHelpers } from '../lib/mmkv';
import { formatNaira } from '../utils/formatCurrency';
import { walletService } from '../services/wallet.service';
import { notificationService } from '../services/notification.service';
import { supabase } from '../lib/supabase';
import type { Transaction } from '../types/app.types';

interface HomeScreenProps {
  navigation: any;
}

interface QuickAction {
  id: string;
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  screen: string;
  comingSoon?: boolean;
  badge?: 'New' | 'Soon';
}

interface Advert {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  sub: string;
  screen?: string;
  comingSoon?: boolean;
}

// Auto-rotating promo adverts on the home screen (owner 2026-07-28). Hardcoded
// for now — can be moved to a Supabase table later so promos are editable
// without an app update.
const ADVERTS: Advert[] = [
  { icon: 'phone-portrait-outline', title: 'Instant airtime, any network', sub: 'MTN, Airtel, Glo, 9mobile in seconds', screen: 'Airtime' },
  { icon: 'cellular-outline', title: 'Cheap data bundles', sub: 'Every network, delivered instantly', screen: 'Data' },
  { icon: 'globe-outline', title: 'Travel eSIMs', sub: 'Stay online in 190+ countries', screen: 'TravelEsim' },
  { icon: 'id-card-outline', title: 'Get your BVN slip', sub: 'Verify and download in seconds', screen: 'NinServices' },
  { icon: 'id-card-outline', title: 'Get your NIN slip', sub: 'Verify and download in seconds', screen: 'NinServices' },
  { icon: 'logo-bitcoin', title: 'Crypto is coming soon', sub: "Buy and sell crypto, soon on Kay's Pay", comingSoon: true },
];

// One unified icon family (Ionicons outline) in brand green — replaces the
// mixed emoji set so every tile reads as part of the same system.
const quickActions: QuickAction[] = [
  { id: '1', icon: 'phone-portrait-outline', label: Strings.SERVICE_AIRTIME, screen: 'Airtime' },
  { id: '2', icon: 'cellular-outline', label: Strings.SERVICE_DATA, screen: 'Data' },
  { id: '4', icon: 'receipt-outline', label: Strings.SERVICE_BILLS, screen: 'Bills' },
  { id: '5', icon: 'tv-outline', label: Strings.SERVICE_TV, screen: 'TV' },
  { id: '3', icon: 'school-outline', label: Strings.SERVICE_EXAMS, screen: 'ExamPins' },
  { id: '7', icon: 'globe-outline', label: Strings.SERVICE_ESIM, screen: 'TravelEsim', badge: 'New' },
  // Foreign Number + Dollar Card hidden (owner 2026-07-28) — re-add to restore.
  { id: '11', icon: 'id-card-outline', label: Strings.SERVICE_NIN, screen: 'NinServices', badge: 'New' },
  // Crypto: not built yet — tapping shows a "coming soon" alert (comingSoon).
  { id: '99', icon: 'logo-bitcoin', label: 'Crypto', screen: 'Crypto', comingSoon: true, badge: 'Soon' },
];

// Auto-rotating advert banner (cycles every 3s). Taps navigate to the service,
// or show the coming-soon alert for Crypto.
function AdvertCarousel({ navigation }: { navigation: any }) {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setIndex((i) => (i + 1) % ADVERTS.length), 3000);
    return () => clearInterval(t);
  }, []);
  const ad = ADVERTS[index];
  return (
    <View style={styles.advertWrap}>
      <TouchableOpacity
        style={styles.advertCard}
        activeOpacity={0.9}
        onPress={() =>
          ad.comingSoon
            ? Alert.alert('Crypto — coming soon', "Buy and sell crypto right inside Kay's Pay. We'll notify you the moment it's live.")
            : ad.screen && navigation.navigate(ad.screen)
        }
      >
        <View style={styles.advertIcon}>
          <Ionicons name={ad.icon} size={22} color="#C79A3A" />
        </View>
        <View style={styles.advertText}>
          <Text style={styles.advertTitle} numberOfLines={1}>{ad.title}</Text>
          <Text style={styles.advertSub} numberOfLines={1}>{ad.sub}</Text>
        </View>
        <Ionicons name="chevron-forward" size={20} color="#C79A3A" />
      </TouchableOpacity>
      <View style={styles.advertDots}>
        {ADVERTS.map((_, i) => (
          <View key={i} style={[styles.advertDot, i === index && styles.advertDotActive]} />
        ))}
      </View>
    </View>
  );
}

export default function HomeScreen({ navigation }: HomeScreenProps) {
  const [balance, setBalance] = useState(0);
  const [balanceVisible, setBalanceVisible] = useState(true);
  const [recentTransactions, setRecentTransactions] = useState<Transaction[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [userName, setUserName] = useState('User');
  // Time-based greeting (from the phone's clock); recomputes whenever Home
  // re-renders (e.g. on focus), so it's current each time the user opens it.
  const greetingHour = new Date().getHours();
  const greeting =
    greetingHour < 12 ? 'Good morning' : greetingHour < 17 ? 'Good afternoon' : 'Good evening';
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [unreadCount, setUnreadCount] = useState(0);

  useEffect(() => {
    loadBalanceVisibility();
    loadData();
    loadUserInfo();
    loadUnread();
    const sub = walletService.subscribeToBalance((newBalance) => {
      setBalance(newBalance);
    });
    // Refresh whenever Home regains focus (e.g. returning from funding or the
    // notifications tab) so the balance and unread count stay current without a
    // manual app refresh.
    const unsubscribeFocus = navigation.addListener('focus', () => {
      loadData();
      loadUnread();
    });

    return () => {
      sub.unsubscribe();
      unsubscribeFocus();
    };
  }, []);

  const loadUnread = async () => {
    setUnreadCount(await notificationService.getUnreadCount());
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
        const avatar = user.user_metadata?.avatar_url || null;
        setAvatarUrl(avatar);
      }
    } catch (error) {
      // silent
    }
  };

  const loadBalanceVisibility = async () => {
    const visible = await storageHelpers.getBoolean(StorageKeys.BALANCE_VISIBLE);
    if (visible !== undefined) {
      setBalanceVisible(visible);
    }
  };

  const loadData = async () => {
    const walletResult = await walletService.getWallet();
    if (walletResult.success && walletResult.wallet) {
      setBalance(walletResult.wallet.balance);
    }

    const txResult = await walletService.getRecentTransactions(5);
    if (txResult.success && txResult.transactions) {
      setRecentTransactions(txResult.transactions);
    }
  };

  const onRefresh = async () => {
    setRefreshing(true);
    await loadData();
    setRefreshing(false);
  };

  const toggleBalanceVisibility = async () => {
    const newValue = !balanceVisible;
    setBalanceVisible(newValue);
    await storageHelpers.setBoolean(StorageKeys.BALANCE_VISIBLE, newValue);
  };

  const getServiceIcon = (type: string) => {
    const icons: Record<string, string> = {
      airtime: '📱',
      data: '📶',
      bill: '💡',
      exam_pin: '📝',
      wallet_fund: '💰',
      refund: '↩️',
    };
    return icons[type] || '💳';
  };

  const formatTimestamp = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  };

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.GREEN_DARK} />

      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Text style={styles.headerGreeting}>Hi, {userName.split(' ')[0]} 👋</Text>
          <Text style={styles.headerGreetingTime}>{greeting}</Text>
        </View>
        <View style={styles.headerRight}>
          <TouchableOpacity
            style={styles.headerIcon}
            onPress={() => navigation.navigate('Notifications')}
          >
            <Ionicons name="notifications-outline" size={24} color={Colors.WHITE} />
            {unreadCount > 0 && (
              <View style={styles.badge}>
                <Text style={styles.badgeText}>{unreadCount > 9 ? '9+' : unreadCount}</Text>
              </View>
            )}
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.headerIcon}
            onPress={() => navigation.navigate('Profile')}
          >
            {avatarUrl ? (
              <Image source={{ uri: avatarUrl }} style={styles.avatarImage} />
            ) : (
              <View style={styles.avatarCircle}>
                <Text style={styles.avatarText}>{userName.charAt(0).toUpperCase()}</Text>
              </View>
            )}
          </TouchableOpacity>
        </View>
      </View>

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
        }
      >
        <View style={styles.walletCard}>
          <Text style={styles.walletLabel}>{Strings.HOME_BALANCE_LABEL}</Text>
          <View style={styles.balanceRow}>
            <Text style={styles.balanceAmount}>
              {balanceVisible ? formatNaira(balance) : '₦ ••••••'}
            </Text>
            <TouchableOpacity onPress={toggleBalanceVisibility}>
              <Text style={styles.eyeIcon}>{balanceVisible ? '👁️' : '👁️‍🗨️'}</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.walletButtons}>
            {/* Withdraw removed with Paystack (owner 2026-07-28) — payout
                gateway (Monnify/Budpay) not yet integrated. Fund only for now. */}
            <TouchableOpacity style={styles.walletButton} onPress={() => navigation.navigate('WalletFunding')}>
              <Text style={styles.walletButtonText}>{Strings.HOME_FUND_WALLET}</Text>
            </TouchableOpacity>
          </View>
        </View>

        <AdvertCarousel navigation={navigation} />

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{Strings.HOME_QUICK_ACTIONS}</Text>
          <View style={styles.quickActionsGrid}>
            {quickActions.map((action) => (
              <TouchableOpacity
                key={action.id}
                style={styles.quickActionItem}
                onPress={() =>
                  action.comingSoon
                    ? Alert.alert('Coming Soon', `${action.label} is on its way — we'll let you know when it's ready.`)
                    : navigation.navigate(action.screen)
                }
              >
                <View style={styles.quickActionIcon}>
                  <Ionicons name={action.icon} size={26} color={Colors.GREEN} />
                  {action.badge && (
                    <View style={[styles.comingSoonBadge, action.badge === 'Soon' && { backgroundColor: Colors.GRAY }]}>
                      <Text style={styles.comingSoonBadgeText}>{action.badge}</Text>
                    </View>
                  )}
                </View>
                <Text style={styles.quickActionLabel} numberOfLines={2}>{action.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>{Strings.HOME_RECENT}</Text>
            <TouchableOpacity
              onPress={() => navigation.navigate('TransactionHistory')}
            >
              <Text style={styles.viewAllText}>{Strings.HOME_VIEW_ALL}</Text>
            </TouchableOpacity>
          </View>

          {recentTransactions.length === 0 ? (
            <View style={styles.emptyState}>
              <Text style={styles.emptyStateText}>No transactions yet</Text>
            </View>
          ) : (
            recentTransactions.map((tx) => (
              <View key={tx.id} style={styles.transactionItem}>
                <View style={styles.transactionLeft}>
                  <View style={styles.transactionIcon}>
                    <Text style={styles.transactionIconText}>
                      {getServiceIcon(tx.type)}
                    </Text>
                  </View>
                  <View style={styles.transactionInfo}>
                    <Text style={styles.transactionType}>
                      {tx.type.charAt(0).toUpperCase() + tx.type.slice(1).replace('_', ' ')}
                    </Text>
                    <Text style={styles.transactionRecipient}>{tx.recipient_phone || 'N/A'}</Text>
                  </View>
                </View>
                <View style={styles.transactionRight}>
                  <Text
                    style={[
                      styles.transactionAmount,
                      { color: tx.type === 'wallet_fund' || tx.type === 'refund' ? Colors.SUCCESS : Colors.RED },
                    ]}
                  >
                    {tx.type === 'wallet_fund' || tx.type === 'refund' ? '+' : '-'}{formatNaira(tx.amount_ngn)}
                  </Text>
                  <Text style={styles.transactionTime}>{formatTimestamp(tx.created_at)}</Text>
                </View>
              </View>
            ))
          )}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.LIGHT_GRAY,
  },
  header: {
    backgroundColor: Colors.GREEN_DARK,
    paddingHorizontal: 16,
    paddingTop: 24,
    paddingBottom: 16,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  headerGreetingTime: {
    fontSize: 13,
    color: Colors.WHITE_80,
    marginTop: 2,
  },
  headerGreeting: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 20,
    color: Colors.WHITE,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  headerIcon: {
    marginLeft: 12,
  },
  iconEmoji: {
    fontSize: 20,
  },
  badge: {
    position: 'absolute',
    top: -4,
    right: -6,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: Colors.RED,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 3,
  },
  badgeText: {
    color: Colors.WHITE,
    fontSize: 10,
    fontWeight: '700',
  },
  avatarCircle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: Colors.GREEN_MID,
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarImage: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 2,
    borderColor: Colors.WHITE,
  },
  avatarText: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 14,
    color: Colors.WHITE,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    padding: 16,
  },
  walletCard: {
    backgroundColor: Colors.GREEN,
    borderRadius: 16,
    paddingHorizontal: 18,
    paddingVertical: 16,
    marginBottom: 16,
  },
  walletLabel: {
    ...Typography.CAPTION,
    color: Colors.WHITE_80,
    marginBottom: 4,
  },
  balanceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 14,
  },
  balanceAmount: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 26,
    color: Colors.WHITE,
  },
  eyeIcon: {
    fontSize: 20,
  },
  walletButtons: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  walletButton: {
    flex: 1,
    height: 42,
    borderWidth: 1,
    borderColor: Colors.WHITE,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
  },
  walletButtonText: {
    ...Typography.BUTTON_TEXT,
    color: Colors.WHITE,
  },
  walletButtonSecondary: {
    flex: 1,
    height: 44,
    borderWidth: 1,
    borderColor: Colors.WHITE,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: 8,
  },
  walletButtonTextSecondary: {
    ...Typography.BUTTON_TEXT,
    color: Colors.WHITE,
  },
  section: {
    marginBottom: 16,
  },
  advertWrap: {
    marginBottom: 16,
  },
  advertCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.GREEN_DARK,
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  advertIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.12)',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  advertText: {
    flex: 1,
  },
  advertTitle: {
    color: Colors.WHITE,
    fontSize: 14,
    fontWeight: '600',
  },
  advertSub: {
    color: '#B8D6C6',
    fontSize: 12,
    marginTop: 1,
  },
  advertDots: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 6,
    marginTop: 8,
  },
  advertDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: Colors.BORDER,
  },
  advertDotActive: {
    width: 16,
    backgroundColor: Colors.AMBER,
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  sectionTitle: {
    ...Typography.SECTION_HEADING,
    marginBottom: 12,
  },
  viewAllText: {
    ...Typography.LINK,
    marginBottom: 12,
  },
  quickActionsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
  },
  quickActionItem: {
    width: '22%',
    alignItems: 'center',
    marginBottom: 12,
  },
  quickActionIcon: {
    width: 60,
    height: 60,
    borderRadius: 16,
    backgroundColor: '#EAF4EE',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 6,
    position: 'relative',
  },
  comingSoonBadge: {
    position: 'absolute',
    top: -6,
    right: -10,
    backgroundColor: Colors.AMBER,
    borderRadius: 8,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  comingSoonBadgeText: {
    fontSize: 8,
    fontWeight: '700',
    color: Colors.WHITE,
  },
  quickActionLabel: {
    ...Typography.CAPTION,
    fontSize: 11,
    lineHeight: 14,
    minHeight: 28,
    textAlign: 'center',
  },
  emptyState: {
    height: 100,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: Colors.WHITE,
    borderRadius: 12,
  },
  emptyStateText: {
    ...Typography.BODY,
    color: Colors.GRAY,
  },
  transactionItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: Colors.WHITE,
    borderRadius: 12,
    padding: 16,
    marginBottom: 8,
    height: 64,
  },
  transactionLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  transactionIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: Colors.LIGHT_GRAY,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  transactionIconText: {
    fontSize: 18,
  },
  transactionInfo: {
    flex: 1,
  },
  transactionType: {
    ...Typography.CARD_TITLE,
    marginBottom: 2,
  },
  transactionRecipient: {
    ...Typography.CAPTION,
  },
  transactionRight: {
    alignItems: 'flex-end',
  },
  transactionAmount: {
    ...Typography.AMOUNT_SMALL,
    marginBottom: 2,
  },
  transactionTime: {
    ...Typography.CAPTION,
  },
});
