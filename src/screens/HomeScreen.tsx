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
import { Colors } from '../constants/colors';
import { Typography } from '../constants/typography';
import { Spacing } from '../constants/spacing';
import { Strings } from '../constants/strings';
import { StorageKeys, storageHelpers } from '../lib/mmkv';
import { formatNaira } from '../utils/formatCurrency';
import { walletService } from '../services/wallet.service';
import { supabase } from '../lib/supabase';
import type { Transaction } from '../types/app.types';

interface HomeScreenProps {
  navigation: any;
}

interface QuickAction {
  id: string;
  icon: string;
  label: string;
  screen: string;
  comingSoon?: boolean;
}

const quickActions: QuickAction[] = [
  { id: '1', icon: '📱', label: Strings.SERVICE_AIRTIME, screen: 'Airtime' },
  { id: '2', icon: '📶', label: Strings.SERVICE_DATA, screen: 'Data' },
  { id: '3', icon: '📝', label: Strings.SERVICE_EXAMS, screen: 'ExamPins' },
  { id: '4', icon: '💡', label: Strings.SERVICE_BILLS, screen: 'Bills' },
  { id: '5', icon: '📺', label: Strings.SERVICE_TV, screen: 'TV' },
  { id: '7', icon: '📡', label: Strings.SERVICE_ESIM, screen: 'TravelEsim' },
  { id: '8', icon: '🌍', label: Strings.SERVICE_FOREIGN, screen: 'ForeignNumber' },
  { id: '9', icon: '💳', label: Strings.SERVICE_DOLLAR_CARD, screen: 'DollarCard', comingSoon: true },
  { id: '11', icon: '🪪', label: Strings.SERVICE_NIN, screen: 'NinServices' },
];

export default function HomeScreen({ navigation }: HomeScreenProps) {
  const [balance, setBalance] = useState(0);
  const [balanceVisible, setBalanceVisible] = useState(true);
  const [recentTransactions, setRecentTransactions] = useState<Transaction[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [userName, setUserName] = useState('User');
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);

  useEffect(() => {
    loadBalanceVisibility();
    loadData();
    loadUserInfo();
    const sub = walletService.subscribeToBalance((newBalance) => {
      setBalance(newBalance);
    });
    // Refresh whenever Home regains focus (e.g. returning from funding) so the
    // balance reflects immediately without a manual app refresh.
    const unsubscribeFocus = navigation.addListener('focus', loadData);

    return () => {
      sub.unsubscribe();
      unsubscribeFocus();
    };
  }, []);

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
        </View>
        <View style={styles.headerRight}>
          <TouchableOpacity
            style={styles.headerIcon}
            onPress={() => navigation.navigate('Notifications')}
          >
            <Text style={styles.iconEmoji}>🔔</Text>
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
            <TouchableOpacity style={styles.walletButton} onPress={() => navigation.navigate('WalletFunding')}>
              <Text style={styles.walletButtonText}>{Strings.HOME_FUND_WALLET}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.walletButtonSecondary} onPress={() => navigation.navigate('Withdraw')}>
              <Text style={styles.walletButtonTextSecondary}>{Strings.HOME_WITHDRAW}</Text>
            </TouchableOpacity>
          </View>
        </View>

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
                  <Text style={styles.quickActionEmoji}>{action.icon}</Text>
                  {action.comingSoon && (
                    <View style={styles.comingSoonBadge}>
                      <Text style={styles.comingSoonBadgeText}>Soon</Text>
                    </View>
                  )}
                </View>
                <Text style={styles.quickActionLabel}>{action.label}</Text>
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
    borderRadius: 12,
    padding: 16,
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
    marginBottom: 16,
  },
  balanceAmount: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 32,
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
    height: 44,
    borderWidth: 1,
    borderColor: Colors.WHITE,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 8,
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
    borderRadius: 12,
    backgroundColor: Colors.WHITE,
    borderWidth: 1,
    borderColor: Colors.BORDER,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 4,
    position: 'relative',
  },
  quickActionEmoji: {
    fontSize: 24,
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
