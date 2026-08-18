import React, { useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import AppNavigator from './src/navigation/AppNavigator';
import { TransactionAuthProvider } from './src/components/TransactionAuthProvider';
import { AppPrivacyGate } from './src/components/AppPrivacyGate';
import { OtaUpdateController } from './src/components/OtaUpdateController';
import { ThemeProvider, useTheme } from './src/components/ThemeProvider';
import { loadAppSettings } from './src/services/appSettings.service';

function ThemedStatusBar() {
  const { theme } = useTheme();
  return <StatusBar style={theme.statusBarStyle} backgroundColor={theme.statusBarBg} />;
}

export default function App() {
  // Owner-editable settings (currently the support WhatsApp number). Fire and
  // forget — loadAppSettings never throws, and every reader falls back to the
  // last persisted or build-time value, so startup never waits on this.
  useEffect(() => {
    void loadAppSettings();
  }, []);

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
