import React, { useCallback, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  FlatList,
  RefreshControl,
  StyleSheet,
  StatusBar,
  ActivityIndicator,
  Modal,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { Colors } from '../constants/colors';
import { Spacing } from '../constants/spacing';
import { Typography } from '../constants/typography';
import { useCachedData } from '../hooks/useCachedData';
import {
  notificationService,
  type AppNotification,
  type NotificationType,
} from '../services/notification.service';

const ICONS: Record<NotificationType, keyof typeof Ionicons.glyphMap> = {
  funding: 'cash-outline',
  withdrawal: 'arrow-up-circle-outline',
  transaction: 'receipt-outline',
  system: 'notifications-outline',
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

export default function NotificationsScreen({ navigation }: { navigation: any }) {
  const { data, loading, refresh } = useCachedData<AppNotification[]>('notifications', () =>
    notificationService.getNotifications(),
  );
  const notifications = data || [];
  const unreadCount = notifications.filter((n) => !n.read).length;
  const [selected, setSelected] = useState<AppNotification | null>(null);
  const insets = useSafeAreaInsets();

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

  const renderNotification = ({ item }: { item: AppNotification }) => (
    <TouchableOpacity
      style={[styles.notificationCard, !item.read && styles.unreadCard]}
      onPress={() => {
        setSelected(item);
        if (!item.read) markAsRead(item.id);
      }}
      activeOpacity={0.7}
    >
      <View style={styles.iconContainer}>
        <Ionicons name={ICONS[item.type] || 'notifications-outline'} size={22} color={Colors.GREEN} />
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
        <Ionicons name="notifications-outline" size={56} color={Colors.GRAY} style={styles.emptyIcon} />
        <Text style={styles.emptyTitle}>No Notifications</Text>
        <Text style={styles.emptyBody}>You're all caught up! New notifications will appear here.</Text>
      </View>
    );

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <StatusBar barStyle="dark-content" backgroundColor={Colors.WHITE} />
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <TouchableOpacity
            onPress={() => (navigation?.canGoBack?.() ? navigation.goBack() : navigation?.navigate?.('HomeTabs'))}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          >
            <Ionicons name="chevron-back" size={26} color={Colors.DARK} />
          </TouchableOpacity>
          <Text style={styles.screenTitle}>Notifications</Text>
        </View>
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

      <Modal
        visible={!!selected}
        transparent
        animationType="slide"
        onRequestClose={() => setSelected(null)}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.modalSheet, { paddingBottom: insets.bottom + Spacing.M }]}>
            <View style={styles.modalHandle} />
            {selected && (
              <>
                <View style={styles.modalIcon}>
                  <Ionicons name={ICONS[selected.type] || 'notifications-outline'} size={28} color={Colors.GREEN} />
                </View>
                <Text style={styles.modalTitle}>{selected.title}</Text>
                <Text style={styles.modalTime}>{timeAgo(selected.createdAt)}</Text>
                <Text style={styles.modalBody}>{selected.body}</Text>
              </>
            )}
            <TouchableOpacity style={styles.modalClose} onPress={() => setSelected(null)} activeOpacity={0.7}>
              <Text style={styles.modalCloseText}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F2F4F3',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.L,
    paddingVertical: Spacing.M,
    backgroundColor: Colors.WHITE,
    borderBottomWidth: 1,
    borderBottomColor: Colors.BORDER,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
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
    padding: Spacing.M,
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
    borderRadius: 14,
    padding: Spacing.M,
    marginBottom: Spacing.M,
    borderWidth: 1,
    borderColor: '#EDF0EE',
    shadowColor: '#0F1A14',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 6,
    elevation: 2,
  },
  unreadCard: {
    backgroundColor: Colors.GREEN_LIGHT,
    borderColor: Colors.GREEN_MID,
  },
  iconContainer: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#EAF4EE',
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
  modalOverlay: {
    flex: 1,
    backgroundColor: Colors.OVERLAY,
    justifyContent: 'flex-end',
  },
  modalSheet: {
    backgroundColor: Colors.WHITE,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: Spacing.L,
    paddingTop: Spacing.S,
    alignItems: 'center',
  },
  modalHandle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: Colors.BORDER,
    marginBottom: Spacing.L,
  },
  modalIcon: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: '#EAF4EE',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: Spacing.M,
  },
  modalTitle: {
    ...Typography.SECTION_HEADING,
    color: Colors.DARK,
    textAlign: 'center',
  },
  modalTime: {
    ...Typography.CAPTION,
    color: Colors.GRAY,
    marginTop: 4,
    marginBottom: Spacing.M,
  },
  modalBody: {
    ...Typography.BODY,
    color: Colors.DARK,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: Spacing.L,
  },
  modalClose: {
    height: Spacing.BUTTON_HEIGHT_PRIMARY,
    borderRadius: Spacing.BUTTON_RADIUS,
    backgroundColor: Colors.GREEN,
    justifyContent: 'center',
    alignItems: 'center',
    alignSelf: 'stretch',
    marginTop: Spacing.S,
  },
  modalCloseText: {
    ...Typography.BUTTON_TEXT,
    color: Colors.WHITE,
  },
});
