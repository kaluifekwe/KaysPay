import React, { useState, useEffect } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createStackNavigator } from '@react-navigation/stack';
import AuthNavigator from './AuthNavigator';
import RequirePinNavigator from './RequirePinNavigator';
import TabNavigator from './TabNavigator';
import AirtimeScreen from '../screens/AirtimeScreen';
import DataScreen from '../screens/DataScreen';
import BulkSendReviewScreen from '../screens/BulkSendReviewScreen';
import BillsScreen from '../screens/BillsScreen';
import ExamPinsScreen from '../screens/ExamPinsScreen';
import TVScreen from '../screens/TVScreen';
import BettingScreen from '../screens/BettingScreen';
import TravelEsimScreen from '../screens/TravelEsimScreen';
import WalletFundingScreen from '../screens/WalletFundingScreen';
import PaystackCheckoutScreen from '../screens/PaystackCheckoutScreen';
import WithdrawScreen from '../screens/WithdrawScreen';
import BankListScreen from '../screens/BankListScreen';
import TransactionHistoryScreen from '../screens/TransactionHistoryScreen';
import ForeignNumbersScreen from '../screens/ForeignNumbersScreen';
import DollarCardsScreen from '../screens/DollarCardsScreen';
import PayrollScreen from '../screens/PayrollScreen';
import NotificationsScreen from '../screens/NotificationsScreen';
import SettingsScreen from '../screens/SettingsScreen';
import ProfileScreen from '../screens/ProfileScreen';
import ChangePinScreen from '../screens/ChangePinScreen';
import { authService } from '../services/auth.service';
import { View, ActivityIndicator, StyleSheet } from 'react-native';
import { Colors } from '../constants/colors';

const RootStack = createStackNavigator();
const MainStack = createStackNavigator();

function MainStackScreen() {
  return (
    <MainStack.Navigator screenOptions={{ headerShown: false }}>
      <MainStack.Screen name="HomeTabs" component={TabNavigator} />
      <MainStack.Screen name="Airtime" component={AirtimeScreen} />
      <MainStack.Screen name="Data" component={DataScreen} />
      <MainStack.Screen name="BulkSendReview" component={BulkSendReviewScreen} />
      <MainStack.Screen name="Bills" component={BillsScreen} />
      <MainStack.Screen name="ExamPins" component={ExamPinsScreen} />
      <MainStack.Screen name="TV" component={TVScreen} />
      <MainStack.Screen name="Betting" component={BettingScreen} />
      <MainStack.Screen name="TravelEsim" component={TravelEsimScreen} />
      <MainStack.Screen name="WalletFunding" component={WalletFundingScreen} />
      <MainStack.Screen name="PaystackCheckout" component={PaystackCheckoutScreen} />
      <MainStack.Screen name="Withdraw" component={WithdrawScreen} />
      <MainStack.Screen name="BankList" component={BankListScreen} />
      <MainStack.Screen name="TransactionHistory" component={TransactionHistoryScreen} />
      <MainStack.Screen name="ForeignNumber" component={ForeignNumbersScreen} />
      <MainStack.Screen name="DollarCard" component={DollarCardsScreen} />
      <MainStack.Screen name="Payroll" component={PayrollScreen} />
      <MainStack.Screen name="Notifications" component={NotificationsScreen} />
      <MainStack.Screen name="Profile" component={ProfileScreen} />
      <MainStack.Screen name="Settings" component={SettingsScreen} />
      <MainStack.Screen name="ChangePin" component={ChangePinScreen} />
    </MainStack.Navigator>
  );
}

export default function AppNavigator() {
  const [isLoading, setIsLoading] = useState(true);
  const [isAuth, setIsAuth] = useState(false);
  // Whether the signed-in user has created a transaction PIN yet. A session
  // existing is NOT enough to reach the Main app — this is what actually
  // gates it, checked fresh on every launch and every auth state change.
  const [hasPin, setHasPin] = useState(false);

  useEffect(() => {
    checkAuth();

    const { data } = authService.onAuthStateChange(async (session) => {
      const authed = !!session;
      setIsAuth(authed);
      setHasPin(authed ? await authService.hasPIN() : false);
    });

    return () => {
      data.subscription.unsubscribe();
    };
  }, []);

  const checkAuth = async () => {
    try {
      const session = await authService.getCurrentSession();
      const authed = !!session;
      setIsAuth(authed);
      if (authed) setHasPin(await authService.hasPIN());
    } catch (error) {
      setIsAuth(false);
    } finally {
      setIsLoading(false);
    }
  };

  if (isLoading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={Colors.GREEN} />
      </View>
    );
  }

  return (
    <NavigationContainer>
      <RootStack.Navigator screenOptions={{ headerShown: false }}>
        {!isAuth ? (
          <RootStack.Screen name="Auth" component={AuthNavigator} />
        ) : !hasPin ? (
          <RootStack.Screen name="RequirePin">
            {() => <RequirePinNavigator onComplete={() => setHasPin(true)} />}
          </RootStack.Screen>
        ) : (
          <RootStack.Screen name="Main" component={MainStackScreen} />
        )}
      </RootStack.Navigator>
    </NavigationContainer>
  );
}

const styles = StyleSheet.create({
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: Colors.WHITE,
  },
});
