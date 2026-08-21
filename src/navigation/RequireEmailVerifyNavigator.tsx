import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import EmailCodeScreen from '../screens/EmailCodeScreen';

const Stack = createNativeStackNavigator();

interface RequireEmailVerifyNavigatorProps {
  /** Called once the signup email code has been verified. */
  onComplete: () => void;
  /** The signed-in user's own email — this is what the code was sent to. */
  email: string;
}

/**
 * Mounted at the ROOT level (see AppNavigator) whenever a session exists but
 * the account's email hasn't been verified yet — same pattern as
 * RequirePinNavigator, and it runs BEFORE that PIN gate. `gestureEnabled:
 * false` blocks the iOS swipe-back since there's nowhere else to go.
 */
export default function RequireEmailVerifyNavigator({ onComplete, email }: RequireEmailVerifyNavigatorProps) {
  return (
    <Stack.Navigator
      screenOptions={{
        headerShown: false,
        gestureEnabled: false,
        contentStyle: { backgroundColor: '#FFFFFF' },
      }}
    >
      <Stack.Screen
        name="EmailVerify"
        component={EmailCodeScreen}
        initialParams={{
          target: email,
          onVerified: async () => {
            // Metadata was updated server-side by verify-email-otp; refresh
            // the local session so AppNavigator's next check of
            // user_metadata.email_verified sees the new value.
            const { supabase } = await import('../lib/supabase');
            await supabase.auth.refreshSession();
            onComplete();
          },
        }}
      />
    </Stack.Navigator>
  );
}
