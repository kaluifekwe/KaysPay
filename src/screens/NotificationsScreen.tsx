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
  Alert,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { Colors } from '../constants/colors';
import { Spacing } from '../constants/spacing';
import { Typography } from '../constants/typography';
import { useCachedData } from '../hooks/useCachedData';
import { formatDateTimeFull, formatDateTimeShort, relativeLabel } from '../utils/formatDateTime';
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

// Derived purely from already-fetched fields (title/type) — a failed
// transaction previously looked visually identical to a successful one,
// which was the main thing making the list read as generic/unpolished.
function accentColor(item: AppNotification): string {
  if (item.title.toLowerCase().includes('failed')) return Colors.ERROR;
  if (item.type === 'withdrawal') return Colors.BLUE;
  if (item.type === 'system') return Colors.GRAY;
  return Colors.GREEN;
}

function timestampLabel(iso: string): string {
  const relative = relativeLabel(iso);
  return relative ? `${relative} · ${formatDateTimeShort(iso)}` : formatDateTimeShort(iso);
}

export default function NotificationsScreen({ navigation }: { navigation: any }) {
  const { data, loading, refresh } = useCachedData<AppNotification[]>('notifications', () =>
    notificationService.getNotifications(),
  );
  const notifications = data || [];
  const unreadCount = notifications.filter((n) => !n.read).length;
  const [detailItem, setDetailItem] = useState<AppNotification | null>(null);
  const [selectedIds, setSelectedIds] = useState<Map<string, AppNotification>>(new Map());
  // Deriving from size (rather than a separate boolean) means deselecting
  // the last selected item automatically exits selection mode for free.
  const selectionMode = selectedIds.size > 0;
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

  const toggleSelect = useCallback((item: AppNotification) => {
    setSelectedIds((prev) => {
      const next = new Map(prev);
      if (next.has(item.id)) next.delete(item.id);
      else next.set(item.id, item);
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => setSelectedIds(new Map()), []);

  const deleteIds = useCallback(
    (ids: string[], onDone: () => void) => {
      Alert.alert(
        ids.length > 1 ? 'Delete notifications' : 'Delete notification',
        `Delete ${ids.length > 1 ? `these ${ids.length} notifications` : 'this notification'}? This can't be undone.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Delete',
            style: 'destructive',
            onPress: async () => {
              try {
                await notificationService.deleteNotifications(ids);
                onDone();
                refresh();
              } catch {
                Alert.alert('Error', 'Could not delete. Please try again.');
              }
            },
          },
        ],
      );
    },
    [refresh],
  );

  const deleteSelected = useCallback(
    () => deleteIds(Array.from(selectedIds.keys()), clearSelection),
    [deleteIds, selectedIds, clearSelection],
  );

  const renderNotification = ({ item }: { item: AppNotification }) => {
    const isSelected = selectedIds.has(item.id);
    const color = accentColor(item);
    return (
      <TouchableOpacity
        style={[styles.notificationCard, !item.read && styles.unreadCard, isSelected && styles.selectedCard]}
        onPress={() => {
          if (selectionMode) {
            toggleSelect(item);
            return;
          }
          setDetailItem(item);
          if (!item.read) markAsRead(item.id);
        }}
        onLongPress={() => toggleSelect(item)}
        activeOpacity={0.7}
      >
        {selectionMode && (
          <View style={[styles.checkbox, isSelected && styles.checkboxChecked]}>
            {isSelected && <Text style={styles.checkboxTick}>✓</Text>}
          </View>
        )}
        <View style={[styles.iconContainer, { backgroundColor: `${color}1A` }]}>
          <Ionicons name={ICONS[item.type] || 'notifications-outline'} size={22} color={color} />
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
          <Text style={styles.timestamp}>{timestampLabel(item.createdAt)}</Text>
        </View>
      </TouchableOpacity>
    );
  };

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
        {selectionMode ? (
          <>
            <View style={styles.headerLeft}>
              <TouchableOpacity onPress={clearSelection} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
                <Ionicons name="close" size={26} color={Colors.DARK} />
              </TouchableOpacity>
              <Text style={styles.screenTitle}>{selectedIds.size} selected</Text>
            </View>
            <TouchableOpacity
              onPress={deleteSelected}
              hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
              style={styles.trashButton}
            >
              <Ionicons name="trash-outline" size={22} color={Colors.ERROR} />
            </TouchableOpacity>
          </>
        ) : (
          <>
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
          </>
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
        visible={!!detailItem}
        transparent
        animationType="slide"
        onRequestClose={() => setDetailItem(null)}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.modalSheet, { paddingBottom: insets.bottom + Spacing.M }]}>
            <View style={styles.modalHandle} />
            {detailItem && (
              <>
                <View style={[styles.modalIcon, { backgroundColor: `${accentColor(detailItem)}1A` }]}>
                  <Ionicons name={ICONS[detailItem.type] || 'notifications-outline'} size={28} color={accentColor(detailItem)} />
                </View>
                <Text style={styles.modalTitle}>{detailItem.title}</Text>
                <Text style={styles.modalTime}>{formatDateTimeFull(detailItem.createdAt)}</Text>
                <Text style={styles.modalBody}>{detailItem.body}</Text>
                <TouchableOpacity
                  style={styles.modalDelete}
                  activeOpacity={0.7}
                  onPress={() => deleteIds([detailItem.id], () => setDetailItem(null))}
                >
                  <Ionicons name="trash-outline" size={16} color={Colors.ERROR} />
                  <Text style={styles.modalDeleteText}>Delete</Text>
                </TouchableOpacity>
              </>
            )}
            <TouchableOpacity style={styles.modalClose} onPress={() => setDetailItem(null)} activeOpacity={0.7}>
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
    alignItems: 'center',
    backgroundColor: Colors.WHITE,
    borderRadius: Spacing.CARD_RADIUS,
    padding: Spacing.CARD_PADDING,
    marginBottom: Spacing.L,
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
  selectedCard: {
    borderColor: Colors.GREEN,
    borderWidth: 2,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: Colors.BORDER,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: Spacing.M,
  },
  checkboxChecked: {
    borderColor: Colors.GREEN,
    backgroundColor: Colors.GREEN,
  },
  checkboxTick: {
    color: Colors.WHITE,
    fontSize: 13,
    fontWeight: '700',
  },
  trashButton: {
    padding: Spacing.XS,
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
  modalDelete: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: Spacing.S,
    paddingHorizontal: Spacing.M,
    marginBottom: Spacing.S,
  },
  modalDeleteText: {
    ...Typography.CAPTION,
    color: Colors.ERROR,
    fontWeight: '600',
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
