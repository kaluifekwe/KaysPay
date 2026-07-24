import React, { useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  FlatList,
  RefreshControl,
  StyleSheet,
  StatusBar,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Colors } from '../constants/colors';
import { Spacing } from '../constants/spacing';
import { Typography } from '../constants/typography';
import { useCachedData } from '../hooks/useCachedData';
import {
  notificationService,
  type AppNotification,
  type NotificationType,
} from '../services/notification.service';

const ICONS: Record<NotificationType, string> = {
  funding: '💰',
  withdrawal: '🏦',
  transaction: '🧾',
  system: '🔔',
};

function timeAgo(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const s = Math.max(1, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min${m > 1 ? 's' : ''} ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hour${h > 1 ? 's' : ''} ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d} day${d > 1 ? 's' : ''} ago`;
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

export default function NotificationsScreen() {
  const { data, loading, refresh } = useCachedData<AppNotification[]>('notifications', () =>
    notificationService.getNotifications(),
  );
  const notifications = data || [];
  const unreadCount = notifications.filter((n) => !n.read).length;

  const markAsRead = useCallback(
    async (id: string) => {
      try {
        await notificationService.markRead(id);
        refresh();
      } catch {
        /* best-effort */
      }
    },
    [refresh],
  );

  const markAllAsRead = useCallback(async () => {
    try {
      await notificationService.markAllRead();
      refresh();
    } catch {
      /* best-effort */
    }
  }, [refresh]);

  const getIconBg = (type: NotificationType): string => {
    switch (type) {
      case 'funding':
        return Colors.GREEN_LIGHT;
      case 'withdrawal':
        return Colors.GREEN_MID;
      case 'system':
        return Colors.AMBER;
      default:
        return Colors.GREEN_LIGHT;
    }
  };

  const renderNotification = ({ item }: { item: AppNotification }) => (
    <TouchableOpacity
      style={[styles.notificationCard, !item.read && styles.unreadCard]}
      onPress={() => !item.read && markAsRead(item.id)}
      activeOpacity={0.7}
    >
      <View style={[styles.iconContainer, { backgroundColor: getIconBg(item.type) }]}>
        <Text style={styles.iconText}>{ICONS[item.type] || '🔔'}</Text>
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
        <Text style={styles.timestamp}>{timeAgo(item.createdAt)}</Text>
      </View>
    </TouchableOpacity>
  );

  const renderEmpty = () =>
    loading ? (
      <View style={styles.emptyContainer}>
        <ActivityIndicator color={Colors.GREEN} />
      </View>
    ) : (
      <View style={styles.emptyContainer}>
        <Text style={styles.emptyIcon}>🔔</Text>
        <Text style={styles.emptyTitle}>No Notifications</Text>
        <Text style={styles.emptyBody}>You're all caught up! New notifications will appear here.</Text>
      </View>
    );

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <StatusBar barStyle="dark-content" backgroundColor={Colors.WHITE} />
      <View style={styles.header}>
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
          <RefreshControl refreshing={loading && notifications.length > 0} onRefresh={refresh} colors={[Colors.GREEN]} tintColor={Colors.GREEN} />
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
    paddingHorizontal: Spacing.L,
    paddingVertical: Spacing.M,
    borderBottomWidth: 1,
    borderBottomColor: Colors.BORDER,
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
