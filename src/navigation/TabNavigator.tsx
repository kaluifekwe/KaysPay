import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { StyleSheet, Linking } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Colors } from '../constants/colors';
import HomeScreen from '../screens/HomeScreen';
import TransactionHistoryScreen from '../screens/TransactionHistoryScreen';
import MoreScreen from '../screens/MoreScreen';

const Tab = createBottomTabNavigator();

// The Support tab opens WhatsApp instead of showing a screen (its tabPress is
// intercepted below), so it just needs a component that never actually renders.
const WHATSAPP_SUPPORT_URL = 'https://wa.me/2348028387709';
function SupportPlaceholder() {
  return null;
}

// Outline when inactive, solid when active — the standard bottom-tab pattern.
// Ionicons are monochrome so they tint with the active/inactive color (emoji
// couldn't), giving a proper green highlight on the selected tab.
const TAB_ICONS: Record<string, { active: keyof typeof Ionicons.glyphMap; inactive: keyof typeof Ionicons.glyphMap }> = {
  Home: { active: 'home', inactive: 'home-outline' },
  History: { active: 'receipt', inactive: 'receipt-outline' },
  Support: { active: 'chatbubble-ellipses', inactive: 'chatbubble-ellipses-outline' },
  Account: { active: 'person', inactive: 'person-outline' },
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
        tabBarIcon: ({ focused, color }) => (
          <Ionicons
            name={focused ? TAB_ICONS[route.name].active : TAB_ICONS[route.name].inactive}
            size={24}
            color={color}
          />
        ),
      })}
    >
      <Tab.Screen name="Home" component={HomeScreen} />
      <Tab.Screen name="History" component={TransactionHistoryScreen} />
      <Tab.Screen
        name="Support"
        component={SupportPlaceholder}
        listeners={{
          tabPress: (e) => {
            // Don't switch tabs — open WhatsApp support instead.
            e.preventDefault();
            Linking.openURL(WHATSAPP_SUPPORT_URL).catch(() => {});
          },
        }}
      />
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
  label: {
    fontSize: 11,
    fontWeight: '600',
    marginBottom: 2,
  },
});
