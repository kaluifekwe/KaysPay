import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Text, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Colors } from '../constants/colors';
import HomeScreen from '../screens/HomeScreen';
import TransactionHistoryScreen from '../screens/TransactionHistoryScreen';
import NotificationsScreen from '../screens/NotificationsScreen';
import MoreScreen from '../screens/MoreScreen';

const Tab = createBottomTabNavigator();

const TAB_ICONS: Record<string, string> = {
  Home: '🏠',
  History: '🧾',
  Alerts: '🔔',
  Account: '👤',
};

export default function TabNavigator() {
  // On Android edge-to-edge (default on SDK 54 / Android 15) and iOS home-bar
  // devices, the OS gesture/navigation bar overlaps the bottom of the screen.
  // Without adding this inset the tab bar renders UNDER the system nav — it
  // looks cut off and its taps land on the OS bar instead of our buttons.
  const insets = useSafeAreaInsets();
  const bottomInset = Math.max(insets.bottom, 8);

  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarActiveTintColor: Colors.GREEN,
        tabBarInactiveTintColor: Colors.GRAY,
        tabBarShowLabel: true,
        tabBarLabelStyle: styles.label,
        tabBarIconStyle: styles.iconWrap,
        tabBarStyle: [
          styles.tabBar,
          { height: 58 + bottomInset, paddingBottom: bottomInset },
        ],
        tabBarIcon: ({ focused }) => (
          <Text style={[styles.icon, focused && styles.iconActive]} allowFontScaling={false}>
            {TAB_ICONS[route.name]}
          </Text>
        ),
      })}
    >
      <Tab.Screen name="Home" component={HomeScreen} />
      <Tab.Screen name="History" component={TransactionHistoryScreen} />
      <Tab.Screen name="Alerts" component={NotificationsScreen} />
      <Tab.Screen name="Account" component={MoreScreen} />
    </Tab.Navigator>
  );
}

const styles = StyleSheet.create({
  tabBar: {
    borderTopWidth: 1,
    borderTopColor: Colors.BORDER,
    backgroundColor: Colors.WHITE,
    paddingTop: 8,
    // Sit above the OS nav bar rather than being clipped behind it.
    elevation: 8,
  },
  iconWrap: {
    marginTop: 2,
  },
  icon: {
    fontSize: 22,
    lineHeight: 26,
  },
  iconActive: {
    transform: [{ scale: 1.12 }],
  },
  label: {
    fontSize: 11,
    fontWeight: '600',
    marginBottom: 2,
  },
});
