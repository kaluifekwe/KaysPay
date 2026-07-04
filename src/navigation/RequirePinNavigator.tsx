import React from 'react';
import { createStackNavigator } from '@react-navigation/stack';
import PINSetupScreen from '../screens/PINSetupScreen';
import BiometricSetupScreen from '../screens/BiometricSetupScreen';

const Stack = createStackNavigator();

interface RequirePinNavigatorProps {
  /** Called once the user has created a PIN (and optionally enabled biometric). */
  onComplete: () => void;
}

/**
 * Mounted at the ROOT level (see AppNavigator) whenever a session exists but
 * the user has no transaction PIN yet — new signups land here immediately,
 * with no route to anywhere else in the app. `gestureEnabled: false` blocks
 * the iOS swipe-back, and since this is the only screen mounted at the root,
 * there's nothing for the Android hardware back button to go back to either.
 * Closing and reopening the app just lands the user right back here, since
 * AppNavigator re-checks "has a PIN" on every launch.
 */
export default function RequirePinNavigator({ onComplete }: RequirePinNavigatorProps) {
  return (
    <Stack.Navigator
      initialRouteName="PINSetup"
      screenOptions={{
        headerShown: false,
        gestureEnabled: false,
        cardStyle: { backgroundColor: '#FFFFFF' },
      }}
    >
      <Stack.Screen name="PINSetup" component={PINSetupScreen} />
      <Stack.Screen name="BiometricSetup">
        {(props) => <BiometricSetupScreen {...props} onComplete={onComplete} />}
      </Stack.Screen>
    </Stack.Navigator>
  );
}
