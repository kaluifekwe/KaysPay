import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  FlatList,
  RefreshControl,
  StyleSheet,
  SafeAreaView,
  StatusBar,
} from 'react-native';
import { Colors } from '../constants/colors';
import { Spacing } from '../constants/spacing';
import { Typography } from '../constants/typography';

type NotificationType = 'transaction' | 'security' | 'promo';

interface Notification {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  timestamp: string;
  read: boolean;
}

const ICONS: Record<NotificationType, string> = {
  transaction: '💰',
  security: '🔒',
  promo: '🎉',
};

const mockNotifications: Notification[] = [
  {
    id: '1',
    type: 'transaction',
    title: 'Airtime Purchased',
    body: 'You purchased ₦500 MTN airtime successfully.',
    timestamp: '2 mins ago',
    read: false,
  },
  {
    id: '2',
    type: 'transaction',
    title: 'Wallet Funded',
    body: 'Your wallet has been funded with ₦10,000 via bank transfer.',
    timestamp: '15 mins ago',
    read: false,
  },
  {
    id: '3',
    type: 'security',
    title: 'New Login Detected',
    body: 'A new login was detected from Lagos, Nigeria. If this wasn\'t you, change your password immediately.',
    timestamp: '1 hour ago',
    read: false,
  },
  {
    id: '4',
    type: 'security',
    title: 'Password Changed',
    body: 'Your password was changed successfully. If you didn\'t make this change, contact support.',
    timestamp: '3 hours ago',
    read: true,
  },
  {
    id: '5',
    type: 'promo',
    title: 'New Feature: Data Bundles',
    body: 'Buy data bundles at the cheapest rates! Tap to explore available plans.',
    timestamp: '1 day ago',
    read: true,
  },
  {
    id: '6',
    type: 'promo',
    title: 'Weekend Offer',
    body: 'Get 10% bonus on all airtime purchases this weekend. Use code WEEKEND10.',
    timestamp: '2 days ago',
    read: true,
  },
];

export default function NotificationsScreen() {
  const [notifications, setNotifications] = useState<Notification[]>(mockNotifications);
  const [refreshing, setRefreshing] = useState(false);

  const unreadCount = notifications.filter((n) => !n.read).length;

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    setTimeout(() => {
      setRefreshing(false);
    }, 1500);
  }, []);

  const markAsRead = useCallback((id: string) => {
    setNotifications((prev) =>
      prev.map((n) => (n.id === id ? { ...n, read: true } : n))
    );
  }, []);

  const markAllAsRead = useCallback(() => {
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
  }, []);

  const getIconBg = (type: NotificationType): string => {
    switch (type) {
      case 'transaction':
        return Colors.GREEN_LIGHT;
      case 'security':
        return Colors.AMBER;
      case 'promo':
        return Colors.GREEN_MID;
      default:
        return Colors.LIGHT_GRAY;
    }
  };

  const renderNotification = ({ item }: { item: Notification }) => (
    <TouchableOpacity
      style={[styles.notificationCard, !item.read && styles.unreadCard]}
      onPress={() => markAsRead(item.id)}
      activeOpacity={0.7}
    >
      <View style={[styles.iconContainer, { backgroundColor: getIconBg(item.type) }]}>
        <Text style={styles.iconText}>{ICONS[item.type]}</Text>
      </View>
      <View style={styles.notificationContent}>
        <View style={styles.titleRow}>
          <Text style={[styles.notificationTitle, !item.read && styles.unreadTitle]} numberOfLines={1}>
            {item.title}
          </Text>
          {!item.read && <View style={styles.unreadDot} />}
        </View>
        <Text style={styles.notificationBody} numberOfLines={2}>
          {item.body}
        </Text>
        <Text style={styles.timestamp}>{item.timestamp}</Text>
      </View>
    </TouchableOpacity>
  );

  const renderEmpty = () => (
    <View style={styles.emptyContainer}>
      <Text style={styles.emptyIcon}>🔔</Text>
      <Text style={styles.emptyTitle}>No Notifications</Text>
      <Text style={styles.emptyBody}>
        You're all caught up! New notifications will appear here.
      </Text>
    </View>
  );

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor={Colors.WHITE} />
      <View style={styles.header}>
        <TouchableOpacity style={styles.backButton} onPress={() => {}}>
          <Text style={styles.backText}>{'<'}</Text>
        </TouchableOpacity>
        <Text style={styles.screenTitle}>Notifications</Text>
        {unreadCount > 0 && (
          <TouchableOpacity style={styles.markAllButton} onPress={markAllAsRead}>
            <Text style={styles.markAllText}>Mark all read</Text>
          </TouchableOpacity>
        )}
      </View>
      <FlatList
        data={notifications}
        renderItem={renderNotification}
        keyExtractor={(item) => item.id}
        contentContainerStyle={notifications.length === 0 ? styles.listEmpty : styles.listContent}
        ListEmptyComponent={renderEmpty}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            colors={[Colors.GREEN]}
            tintColor={Colors.GREEN}
          />
        }
        showsVerticalScrollIndicator={false}
      />
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
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.S,
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
  backText: {
    fontSize: 28,
    fontWeight: '600',
    color: Colors.DARK,
  },
  screenTitle: {
    ...Typography.SCREEN_TITLE,
    color: Colors.DARK,
  },
  markAllButton: {
    paddingHorizontal: Spacing.S,
    paddingVertical: Spacing.XS,
  },
  markAllText: {
    ...Typography.CAPTION,
    color: Colors.GREEN,
    fontWeight: '600',
  },
  listContent: {
    padding: Spacing.S,
    paddingBottom: Spacing.XL,
  },
  listEmpty: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: Spacing.XL,
  },
  notificationCard: {
    flexDirection: 'row',
    backgroundColor: Colors.WHITE,
    borderRadius: Spacing.S,
    padding: Spacing.M,
    marginBottom: Spacing.S,
    borderWidth: 1,
    borderColor: Colors.BORDER,
  },
  unreadCard: {
    backgroundColor: Colors.GREEN_LIGHT,
    borderColor: Colors.GREEN_MID,
  },
  iconContainer: {
    width: 48,
    height: 48,
    borderRadius: 24,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: Spacing.M,
  },
  iconText: {
    fontSize: 22,
  },
  notificationContent: {
    flex: 1,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: Spacing.XS,
  },
  notificationTitle: {
    ...Typography.CARD_TITLE,
    color: Colors.DARK,
    flex: 1,
  },
  unreadTitle: {
    fontWeight: '700',
  },
  unreadDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: Colors.GREEN,
    marginLeft: Spacing.S,
  },
  notificationBody: {
    ...Typography.BODY,
    color: Colors.GRAY,
    marginBottom: Spacing.XS,
  },
  timestamp: {
    ...Typography.CAPTION,
    color: Colors.GRAY,
  },
  emptyContainer: {
    alignItems: 'center',
  },
  emptyIcon: {
    fontSize: 64,
    marginBottom: Spacing.L,
  },
  emptyTitle: {
    ...Typography.SECTION_HEADING,
    color: Colors.DARK,
    marginBottom: Spacing.S,
  },
  emptyBody: {
    ...Typography.BODY,
    color: Colors.GRAY,
    textAlign: 'center',
  },
});
