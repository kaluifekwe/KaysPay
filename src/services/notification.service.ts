import { supabase } from '../lib/supabase';
import { withTimeout } from '../utils/network';

export type NotificationType = 'funding' | 'withdrawal' | 'transaction' | 'system';

export interface AppNotification {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  read: boolean;
  createdAt: string;
}

export const notificationService = {
  // The user's own notifications (RLS restricts to auth.uid()). Most recent
  // first; capped so the feed stays light on older devices / slow networks.
  async getNotifications(limit = 50): Promise<AppNotification[]> {
    const { data, error } = await withTimeout(
      (async () =>
        await supabase
          .from('notifications')
          .select('id, type, title, body, read, created_at')
          .order('created_at', { ascending: false })
          .limit(limit))(),
    );
    if (error) throw new Error(error.message || 'Could not load notifications');
    return (data || []).map((n: any) => ({
      id: String(n.id),
      type: (n.type as NotificationType) || 'system',
      title: String(n.title || ''),
      body: String(n.body || ''),
      read: !!n.read,
      createdAt: String(n.created_at),
    }));
  },

  async getUnreadCount(): Promise<number> {
    try {
      const { count } = await withTimeout(
        (async () =>
          await supabase
            .from('notifications')
            .select('id', { count: 'exact', head: true })
            .eq('read', false))(),
      );
      return count || 0;
    } catch {
      return 0;
    }
  },

  async markRead(id: string): Promise<void> {
    await withTimeout((async () => supabase.rpc('mark_notification_read', { p_id: id }))());
  },

  async markAllRead(): Promise<void> {
    await withTimeout((async () => supabase.rpc('mark_all_notifications_read'))());
  },

  // Destructive, so unlike markRead/markAllRead (best-effort/silent) this
  // throws — the screen should show a real error on failure, not swallow it.
  async deleteNotifications(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const { error } = await withTimeout(
      (async () => supabase.rpc('delete_notifications', { p_ids: ids }))(),
    );
    if (error) throw new Error(error.message || 'Could not delete notifications');
  },
};
