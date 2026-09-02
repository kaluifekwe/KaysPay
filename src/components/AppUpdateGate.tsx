import React, { useCallback, useEffect, useState } from 'react';
import { Linking, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { AppTheme } from '../constants/theme';
import { useTheme } from './ThemeProvider';
import { checkAppVersionGate } from '../services/appVersionGate.service';
import { supportWhatsAppUrl } from '../services/appSettings.service';

/**
 * The "required" half of the app update gate — sits above everything else,
 * including AppPrivacyGate, so a build the owner has marked unsafe to keep
 * running never even reaches the PIN/session check. Checked once per app
 * launch; a dismissible "recommended" nudge for the non-blocking case lives
 * separately on HomeScreen, not here.
 */
export function AppUpdateGate({ children }: { children: React.ReactNode }) {
  const { theme } = useTheme();
  const styles = createStyles(theme);
  const [blocked, setBlocked] = useState(false);
  const [info, setInfo] = useState<{ message: string; storeUrl: string; minVersion: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void checkAppVersionGate().then((result) => {
      if (cancelled) return;
      if (result.configured && result.needsUpdate && result.required) {
        setInfo({ message: result.message, storeUrl: result.storeUrl, minVersion: result.minVersion });
        setBlocked(true);
      }
    });
    return () => { cancelled = true; };
  }, []);

  const openStore = useCallback(() => {
    if (info?.storeUrl) void Linking.openURL(info.storeUrl);
  }, [info]);

  const contactSupport = useCallback(() => {
    void Linking.openURL(supportWhatsAppUrl());
  }, []);

  return (
    <View style={styles.root}>
      {children}
      {blocked && info && (
        <View style={styles.cover} accessibilityViewIsModal>
          <View style={styles.iconCircle}>
            <Ionicons name="arrow-up" size={34} color="#FFFFFF" />
          </View>
          <Text style={styles.title}>Update Required</Text>
          <Text style={styles.message}>{info.message}</Text>
          <TouchableOpacity style={styles.button} onPress={openStore} activeOpacity={0.85}>
            <Text style={styles.buttonText}>Update Now</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={contactSupport} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Text style={styles.supportLink}>Having trouble? Contact support</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    root: { flex: 1 },
    cover: {
      ...StyleSheet.absoluteFillObject,
      zIndex: 2000,
      elevation: 2000,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.background,
      paddingHorizontal: 32,
    },
    iconCircle: {
      width: 76,
      height: 76,
      borderRadius: 38,
      backgroundColor: theme.brand,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: 22,
    },
    title: { fontSize: 21, fontWeight: '800', color: theme.ink, marginBottom: 10 },
    message: { fontSize: 14, lineHeight: 20, color: theme.inkMuted, textAlign: 'center', maxWidth: 260, marginBottom: 26 },
    button: {
      width: '100%',
      maxWidth: 280,
      backgroundColor: theme.brand,
      borderRadius: 14,
      paddingVertical: 15,
      alignItems: 'center',
    },
    buttonText: { color: '#FFFFFF', fontSize: 15, fontWeight: '700' },
    supportLink: {
      marginTop: 16,
      fontSize: 12,
      color: theme.inkMuted,
      textDecorationLine: 'underline',
    },
  });
}
