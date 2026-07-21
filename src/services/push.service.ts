import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { supabase } from '../lib/supabase';

// Public EAS project id (same value that's in app.json extra.eas.projectId —
// not a secret). Needed by getExpoPushTokenAsync in a bare/EAS build.
const EAS_PROJECT_ID = 'cf76d478-2ceb-4f07-8e52-9864d94437fa';

// Show notifications while the app is in the foreground too. Both the legacy
// (shouldShowAlert) and SDK 54 (shouldShowBanner/List) fields are set so it
// behaves the same across versions.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

export const pushService = {
  // Best-effort: request permission, get the Expo push token, and register it
  // server-side against the current user. Never throws — push is a nicety, it
  // must not block or crash the app if permission is denied or unavailable.
  async registerForPush(): Promise<void> {
    try {
      if (Platform.OS === 'android') {
        await Notifications.setNotificationChannelAsync('default', {
          name: 'Default',
          importance: Notifications.AndroidImportance.DEFAULT,
        });
      }

      const existing = await Notifications.getPermissionsAsync();
      let status = existing.status;
      if (status !== 'granted') {
        status = (await Notifications.requestPermissionsAsync()).status;
      }
      if (status !== 'granted') return;

      const tokenResponse = await Notifications.getExpoPushTokenAsync({ projectId: EAS_PROJECT_ID });
      const token = tokenResponse?.data;
      if (!token) return;

      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return;

      // Server-authoritative upsert (RPC) so a device that switches accounts
      // reassigns cleanly to the new user.
      await supabase.rpc('register_push_token', { p_token: token, p_platform: Platform.OS });
    } catch {
      // swallow — push registration is best-effort
    }
  },
};
