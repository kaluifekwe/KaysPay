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
import { AppTheme } from '../constants/theme';
import { useTheme } from '../components/ThemeProvider';
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
// '#3B82F6' (withdrawal's blue accent) is a literal, not a theme token —
// it's legible on both a white and a near-black card without needing to
// flip shade, unlike the brand/gold/error colors which do adapt per theme.
function accentColor(theme: AppTheme, item: AppNotification): string {
  if (item.title.toLowerCase().includes('failed')) return theme.down;
  if (item.type === 'withdrawal') return '#3B82F6';
  if (item.type === 'system') return theme.inkMuted;
  return theme.brand;
}

function timestampLabel(iso: string): string {
  const relative = relativeLabel(iso);
  return relative ? `${relative} · ${formatDateTimeShort(iso)}` : formatDateTimeShort(iso);
}

export default function NotificationsScreen({ navigation }: { navigation: any }) {
  const { theme } = useTheme();
  const styles = createStyles(theme);
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
    const color = accentColor(theme, item);
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
        <ActivityIndicator color={theme.brand} />
      </View>
    ) : (
      <View style={styles.emptyContainer}>
        <Ionicons name="notifications-outline" size={56} color={theme.inkMuted} style={styles.emptyIcon} />
        <Text style={styles.emptyTitle}>No Notifications</Text>
        <Text style={styles.emptyBody}>You're all caught up! New notifications will appear here.</Text>
      </View>
    );

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <StatusBar barStyle={theme.mode === 'dark' ? 'light-content' : 'dark-content'} backgroundColor={theme.background} />
      <View style={styles.header}>
        {selectionMode ? (
          <>
            <View style={styles.headerLeft}>
              <TouchableOpacity onPress={clearSelection} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
                <Ionicons name="close" size={26} color={theme.ink} />
              </TouchableOpacity>
              <Text style={styles.screenTitle}>{selectedIds.size} selected</Text>
            </View>
            <TouchableOpacity
              onPress={deleteSelected}
              hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
              style={styles.trashButton}
            >
              <Ionicons name="trash-outline" size={22} color={theme.down} />
            </TouchableOpacity>
          </>
        ) : (
          <>
            <View style={styles.headerLeft}>
              <TouchableOpacity
                onPress={() => (navigation?.canGoBack?.() ? navigation.goBack() : navigation?.navigate?.('HomeTabs'))}
                hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
              >
                <Ionicons name="chevron-back" size={26} color={theme.ink} />
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
          <RefreshControl refreshing={loading && notifications.length > 0} onRefresh={refresh} colors={[theme.brand]} tintColor={theme.brand} />
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
                <View style={[styles.modalIcon, { backgroundColor: `${accentColor(theme, detailItem)}1A` }]}>
                  <Ionicons name={ICONS[detailItem.type] || 'notifications-outline'} size={28} color={accentColor(theme, detailItem)} />
                </View>
                <Text style={styles.modalTitle}>{detailItem.title}</Text>
                <Text style={styles.modalTime}>{formatDateTimeFull(detailItem.createdAt)}</Text>
                <Text style={styles.modalBody}>{detailItem.body}</Text>
                <TouchableOpacity
                  style={styles.modalDelete}
                  activeOpacity={0.7}
                  onPress={() => deleteIds([detailItem.id], () => setDetailItem(null))}
                >
                  <Ionicons name="trash-outline" size={16} color={theme.down} />
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

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.background,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.L,
    paddingVertical: Spacing.M,
    backgroundColor: theme.surface,
    borderBottomWidth: 1,
    borderBottomColor: theme.border,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  screenTitle: {
    ...Typography.SCREEN_TITLE,
    color: theme.ink,
  },
  markAllButton: {
    paddingHorizontal: Spacing.S,
    paddingVertical: Spacing.XS,
  },
  markAllText: {
    ...Typography.CAPTION,
    color: theme.brand,
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
    backgroundColor: theme.surface,
    borderRadius: Spacing.CARD_RADIUS,
    padding: Spacing.CARD_PADDING,
    marginBottom: Spacing.L,
    borderWidth: 1,
    borderColor: theme.hairline,
    shadowColor: '#0F1A14',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 6,
    elevation: 2,
  },
  unreadCard: {
    backgroundColor: theme.brandSoft,
    borderColor: theme.brand,
  },
  selectedCard: {
    borderColor: theme.brand,
    borderWidth: 2,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: theme.border,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: Spacing.M,
  },
  checkboxChecked: {
    borderColor: theme.brand,
    backgroundColor: theme.brand,
  },
  checkboxTick: {
    color: '#FFFFFF',
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
    color: theme.ink,
    flex: 1,
  },
  unreadTitle: {
    fontWeight: '700',
  },
  unreadDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: theme.brand,
    marginLeft: Spacing.S,
  },
  notificationBody: {
    ...Typography.BODY,
    color: theme.inkMuted,
    marginBottom: Spacing.XS,
  },
  timestamp: {
    ...Typography.CAPTION,
    color: theme.inkMuted,
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
    color: theme.ink,
    marginBottom: Spacing.S,
  },
  emptyBody: {
    ...Typography.BODY,
    color: theme.inkMuted,
    textAlign: 'center',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  modalSheet: {
    backgroundColor: theme.surface,
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
    backgroundColor: theme.border,
    marginBottom: Spacing.L,
  },
  modalIcon: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: theme.brandSoft,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: Spacing.M,
  },
  modalTitle: {
    ...Typography.SECTION_HEADING,
    color: theme.ink,
    textAlign: 'center',
  },
  modalTime: {
    ...Typography.CAPTION,
    color: theme.inkMuted,
    marginTop: 4,
    marginBottom: Spacing.M,
  },
  modalBody: {
    ...Typography.BODY,
    color: theme.ink,
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
    color: theme.down,
    fontWeight: '600',
  },
  modalClose: {
    height: Spacing.BUTTON_HEIGHT_PRIMARY,
    borderRadius: Spacing.BUTTON_RADIUS,
    backgroundColor: theme.brand,
    justifyContent: 'center',
    alignItems: 'center',
    alignSelf: 'stretch',
    marginTop: Spacing.S,
  },
  modalCloseText: {
    ...Typography.BUTTON_TEXT,
    color: '#FFFFFF',
  },
  });
}
