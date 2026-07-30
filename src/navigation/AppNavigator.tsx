import React, { useState, useEffect } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createStackNavigator } from '@react-navigation/stack';
import AuthNavigator from './AuthNavigator';
import RequireEmailVerifyNavigator from './RequireEmailVerifyNavigator';
import RequirePinNavigator from './RequirePinNavigator';
import TabNavigator from './TabNavigator';
import { navigationRef } from './navigationRef';
import AirtimeScreen from '../screens/AirtimeScreen';
import DataScreen from '../screens/DataScreen';
import TransactionStatusScreen from '../screens/TransactionStatusScreen';
import BulkSendReviewScreen from '../screens/BulkSendReviewScreen';
import BillsScreen from '../screens/BillsScreen';
import ElectricityPayScreen from '../screens/ElectricityPayScreen';
import ExamPinsScreen from '../screens/ExamPinsScreen';
import TVScreen from '../screens/TVScreen';
import NinServicesScreen from '../screens/NinServicesScreen';
import TravelEsimScreen from '../screens/TravelEsimScreen';
import WalletFundingScreen from '../screens/WalletFundingScreen';
import TransactionHistoryScreen from '../screens/TransactionHistoryScreen';
import ForeignNumbersScreen from '../screens/ForeignNumbersScreen';
import DollarCardsScreen from '../screens/DollarCardsScreen';
import NotificationsScreen from '../screens/NotificationsScreen';
import SettingsScreen from '../screens/SettingsScreen';
import ProfileScreen from '../screens/ProfileScreen';
import EditProfileScreen from '../screens/EditProfileScreen';
import KycScreen from '../screens/KycScreen';
import ChangePinScreen from '../screens/ChangePinScreen';
import LegalDocumentScreen from '../screens/LegalDocumentScreen';
import { authService } from '../services/auth.service';
import { pushService } from '../services/push.service';
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
      <MainStack.Screen name="TransactionStatus" component={TransactionStatusScreen} />
      <MainStack.Screen name="BulkSendReview" component={BulkSendReviewScreen} />
      <MainStack.Screen name="Bills" component={BillsScreen} />
      <MainStack.Screen name="ElectricityPay" component={ElectricityPayScreen} />
      <MainStack.Screen name="ExamPins" component={ExamPinsScreen} />
      <MainStack.Screen name="TV" component={TVScreen} />
      <MainStack.Screen name="NinServices" component={NinServicesScreen} />
      <MainStack.Screen name="TravelEsim" component={TravelEsimScreen} />
      <MainStack.Screen name="WalletFunding" component={WalletFundingScreen} />
      <MainStack.Screen name="TransactionHistory" component={TransactionHistoryScreen} />
      <MainStack.Screen name="ForeignNumber" component={ForeignNumbersScreen} />
      <MainStack.Screen name="DollarCard" component={DollarCardsScreen} />
      <MainStack.Screen name="Notifications" component={NotificationsScreen} />
      <MainStack.Screen name="Profile" component={ProfileScreen} />
      <MainStack.Screen name="EditProfile" component={EditProfileScreen} />
      <MainStack.Screen name="Kyc" component={KycScreen} />
      <MainStack.Screen name="Settings" component={SettingsScreen} />
      <MainStack.Screen name="ChangePin" component={ChangePinScreen} />
      <MainStack.Screen name="LegalDocument" component={LegalDocumentScreen} />
    </MainStack.Navigator>
  );
}

export default function AppNavigator() {
  const [isLoading, setIsLoading] = useState(true);
  const [isAuth, setIsAuth] = useState(false);
  // Whether the signed-in user's email has been verified via our own
  // Resend-based code (replaces Supabase's link-based "Confirm email").
  // Checked before hasPin so a brand-new signup verifies email first.
  const [hasVerifiedEmail, setHasVerifiedEmail] = useState(false);
  const [userEmail, setUserEmail] = useState('');
  // Whether the signed-in user has created a transaction PIN yet. A session
  // existing is NOT enough to reach the Main app — this is what actually
  // gates it, checked fresh on every launch and every auth state change.
  const [hasPin, setHasPin] = useState(false);

  useEffect(() => {
    checkAuth();

    const { data } = authService.onAuthStateChange(async (session) => {
      const authed = !!session;
      setIsAuth(authed);
      setUserEmail(session?.user?.email || '');
      setHasVerifiedEmail(authed ? session.user.user_metadata?.email_verified === true : false);
      setHasPin(authed ? await authService.hasPIN() : false);
    });

    return () => {
      data.subscription.unsubscribe();
    };
  }, []);

  // Once the user is fully signed in (email verified + PIN set), register this
  // device for push. Idempotent + best-effort — safe to run on every change.
  useEffect(() => {
    if (isAuth && hasVerifiedEmail && hasPin) {
      pushService.registerForPush();
    }
  }, [isAuth, hasVerifiedEmail, hasPin]);

  // Catch-all guarantee against being asked to create a PIN twice: if we're
  // about to show the PIN gate (signed in, email verified, but no PIN on
  // record), first try to persist the PIN the user already entered at signup.
  // By this point the session is fully established, so set_user_pin reliably
  // works — unlike the split second right after signUp. If it saves, we skip
  // the gate entirely. Covers every path (email-verify completion, app
  // relaunch mid-flow), not just the happy one.
  useEffect(() => {
    if (isAuth && hasVerifiedEmail && !hasPin) {
      let cancelled = false;
      authService.ensurePinSaved().then((ok) => {
        if (ok && !cancelled) setHasPin(true);
      });
      return () => {
        cancelled = true;
      };
    }
  }, [isAuth, hasVerifiedEmail, hasPin]);

  const checkAuth = async () => {
    try {
      const session = await authService.getCurrentSession();
      const authed = !!session;
      setIsAuth(authed);
      if (authed) {
        setUserEmail(session.user.email || '');
        setHasVerifiedEmail(session.user.user_metadata?.email_verified === true);
        setHasPin(await authService.hasPIN());
      }
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
    <NavigationContainer ref={navigationRef}>
      <RootStack.Navigator screenOptions={{ headerShown: false }}>
        {!isAuth ? (
          <RootStack.Screen name="Auth" component={AuthNavigator} />
        ) : !hasVerifiedEmail ? (
          <RootStack.Screen name="RequireEmailVerify">
            {() => (
              <RequireEmailVerifyNavigator
                email={userEmail}
                onComplete={async () => {
                  // Signup already saved the PIN (see RegistrationScreen), but
                  // the auth-state-change check above ran a moment before that
                  // save landed, so hasPin can be stale-false here. Re-check the
                  // real server state now so a user who set their PIN during
                  // signup skips the redundant "Create Transaction PIN" gate.
                  // It still shows only if the PIN genuinely didn't save.
                  setHasPin(await authService.hasPIN());
                  setHasVerifiedEmail(true);
                }}
              />
            )}
          </RootStack.Screen>
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
