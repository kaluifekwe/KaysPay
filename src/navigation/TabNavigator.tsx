import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { View, Text, StyleSheet } from 'react-native';
import { Colors } from '../constants/colors';
import { Typography } from '../constants/typography';
import { Spacing } from '../constants/spacing';
import HomeScreen from '../screens/HomeScreen';
import TransactionHistoryScreen from '../screens/TransactionHistoryScreen';
import NotificationsScreen from '../screens/NotificationsScreen';
import MoreScreen from '../screens/MoreScreen';

const Tab = createBottomTabNavigator();

const TabIcon = ({ icon, label, focused }: { icon: string; label: string; focused: boolean }) => (
  <View style={styles.tabIconContainer}>
    <Text style={[styles.tabIcon, focused && styles.tabIconActive]}>{icon}</Text>
    <Text style={[styles.tabLabel, focused && styles.tabLabelActive]}>{label}</Text>
  </View>
);

export default function TabNavigator() {
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarStyle: styles.tabBar,
        tabBarActiveTintColor: Colors.GREEN,
        tabBarInactiveTintColor: Colors.GRAY,
        tabBarShowLabel: false,
      }}
    >
      <Tab.Screen
        name="Home"
        component={HomeScreen}
        options={{ tabBarIcon: ({ focused }) => <TabIcon icon="🏠" label="Home" focused={focused} /> }}
      />
      <Tab.Screen
        name="History"
        component={TransactionHistoryScreen}
        options={{ tabBarIcon: ({ focused }) => <TabIcon icon="🧾" label="History" focused={focused} /> }}
      />
      <Tab.Screen
        name="Alerts"
        component={NotificationsScreen}
        options={{ tabBarIcon: ({ focused }) => <TabIcon icon="🔔" label="Alerts" focused={focused} /> }}
      />
      <Tab.Screen
        name="Account"
        component={MoreScreen}
        options={{ tabBarIcon: ({ focused }) => <TabIcon icon="👤" label="Account" focused={focused} /> }}
      />
    </Tab.Navigator>
  );
}

const styles = StyleSheet.create({
  tabBar: {
    height: Spacing.BOTTOM_TAB_HEIGHT,
    borderTopWidth: 1,
    borderTopColor: Colors.BORDER,
    backgroundColor: Colors.WHITE,
    paddingTop: Spacing.S,
  },
  tabIconContainer: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabIcon: {
    fontSize: 20,
    marginBottom: 2,
  },
  tabIconActive: {
    transform: [{ scale: 1.1 }],
  },
  tabLabel: {
    ...Typography.CAPTION,
    color: Colors.GRAY,
  },
  tabLabelActive: {
    color: Colors.GREEN,
    fontWeight: '600',
  },
});
