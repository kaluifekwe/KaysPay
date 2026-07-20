import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { View, Text, StyleSheet } from 'react-native';
import { Colors } from '../constants/colors';
import { Typography } from '../constants/typography';
import { Spacing } from '../constants/spacing';
import { Strings } from '../constants/strings';
import { Features } from '../constants/features';
import HomeScreen from '../screens/HomeScreen';
import PayScreen from '../screens/PayScreen';
import CardsScreen from '../screens/CardsScreen';
import PayrollScreen from '../screens/PayrollScreen';
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
        options={{
          tabBarIcon: ({ focused }) => (
            <TabIcon icon="🏠" label={Strings.SERVICE_AIRTIME} focused={focused} />
          ),
        }}
      />
      <Tab.Screen
        name="Pay"
        component={PayScreen}
        options={{
          tabBarIcon: ({ focused }) => (
            <TabIcon icon="💳" label="Pay" focused={focused} />
          ),
        }}
      />
      <Tab.Screen
        name="Cards"
        component={CardsScreen}
        options={{
          tabBarIcon: ({ focused }) => (
            <TabIcon icon="🃏" label="Cards" focused={focused} />
          ),
        }}
      />
      {Features.PAYROLL_ENABLED && (
        <Tab.Screen
          name="Payroll"
          component={PayrollScreen}
          options={{
            tabBarIcon: ({ focused }) => (
              <TabIcon icon="👥" label="Payroll" focused={focused} />
            ),
          }}
        />
      )}
      <Tab.Screen
        name="More"
        component={MoreScreen}
        options={{
          tabBarIcon: ({ focused }) => (
            <TabIcon icon="☰" label="More" focused={focused} />
          ),
        }}
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
