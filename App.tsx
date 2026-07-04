import React from 'react';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import AppNavigator from './src/navigation/AppNavigator';
import { TransactionAuthProvider } from './src/components/TransactionAuthProvider';

export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar style="light" backgroundColor="#0F3D27" />
      <TransactionAuthProvider>
        <AppNavigator />
      </TransactionAuthProvider>
    </SafeAreaProvider>
  );
}
