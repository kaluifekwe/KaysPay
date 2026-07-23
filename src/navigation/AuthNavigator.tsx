import React from 'react';
import { createStackNavigator } from '@react-navigation/stack';
import SplashScreen from '../screens/SplashScreen';
import WelcomeScreen from '../screens/WelcomeScreen';
import OnboardingScreen from '../screens/OnboardingScreen';
import RegistrationScreen from '../screens/RegistrationScreen';
import LoginScreen from '../screens/LoginScreen';
import ForgotPasswordScreen from '../screens/ForgotPasswordScreen';
import ResetPasswordScreen from '../screens/ResetPasswordScreen';
import PhoneInputScreen from '../screens/PhoneInputScreen';
import OTPVerifyScreen from '../screens/OTPVerifyScreen';

const Stack = createStackNavigator();

// PIN/biometric setup is NOT part of this stack — it's mounted at the root
// (see AppNavigator + RequirePinNavigator) as a hard, un-skippable gate that
// exists independently of however a session got created here (signup, OTP,
// or login). Keeping it out of this stack also removes the race that let a
// signup slip straight into the Main app: PINSetup used to live here, and
// the moment supabase.auth.signUp() created a session, AppNavigator's
// isAuth flip could unmount this whole stack before navigation.replace
// ('PINSetup') ever resolved.
export default function AuthNavigator() {
  return (
    <Stack.Navigator
      initialRouteName="Splash"
      screenOptions={{
        headerShown: false,
        cardStyle: { backgroundColor: '#FFFFFF' },
      }}
    >
      <Stack.Screen name="Splash" component={SplashScreen} />
      <Stack.Screen name="Welcome" component={WelcomeScreen} />
      <Stack.Screen name="Onboarding" component={OnboardingScreen} />
      <Stack.Screen name="Registration" component={RegistrationScreen} />
      <Stack.Screen name="Login" component={LoginScreen} />
      <Stack.Screen name="ForgotPassword" component={ForgotPasswordScreen} />
      <Stack.Screen name="ResetPassword" component={ResetPasswordScreen} />
      <Stack.Screen name="PhoneInput" component={PhoneInputScreen} />
      <Stack.Screen
        name="OTPVerify"
        component={OTPVerifyScreen}
        options={{ gestureEnabled: false }}
      />
    </Stack.Navigator>
  );
}
