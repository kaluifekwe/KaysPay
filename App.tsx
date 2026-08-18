import React from 'react';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import AppNavigator from './src/navigation/AppNavigator';
import { TransactionAuthProvider } from './src/components/TransactionAuthProvider';
import { AppPrivacyGate } from './src/components/AppPrivacyGate';
import { OtaUpdateController } from './src/components/OtaUpdateController';
import { ThemeProvider, useTheme } from './src/components/ThemeProvider';

function ThemedStatusBar() {
  const { theme } = useTheme();
  return <StatusBar style={theme.statusBarStyle} backgroundColor={theme.statusBarBg} />;
}

export default function App() {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <ThemedStatusBar />
        <TransactionAuthProvider>
          <OtaUpdateController />
          <AppPrivacyGate>
            <AppNavigator />
          </AppPrivacyGate>
        </TransactionAuthProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
