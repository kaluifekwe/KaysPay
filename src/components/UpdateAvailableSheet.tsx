import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Linking, Modal, StyleSheet, Text, TouchableOpacity, TouchableWithoutFeedback, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { AppTheme } from '../constants/theme';
import { useTheme } from './ThemeProvider';
import { checkAppVersionGate } from '../services/appVersionGate.service';

// Once per cold start, not persisted -- a fresh app launch is exactly what
// re-runs this module, so a plain in-memory flag already gives "ask again
// next time they open the app" for free, with no storage needed.
let shownThisSession = false;

/**
 * The "recommended" half of the app update gate — a dismissible nudge shown
 * once per app open, after Home has already rendered. Never blocks anything;
 * the full-screen blocking gate for a "required" release is AppUpdateGate,
 * mounted separately at the app root.
 */
export function UpdateAvailableSheet() {
  const { theme } = useTheme();
  const styles = createStyles(theme);
  const [visible, setVisible] = useState(false);
  const infoRef = useRef<{ message: string; storeUrl: string } | null>(null);

  useEffect(() => {
    if (shownThisSession) return;
    let cancelled = false;
    void checkAppVersionGate().then((result) => {
      if (cancelled) return;
      // A "required" release is AppUpdateGate's job, not this one — if
      // both are somehow true at once (a race right as an admin raises the
      // flag), the blocking gate takes priority and this simply never fires.
      if (result.configured && result.needsUpdate && !result.required) {
        shownThisSession = true;
        infoRef.current = { message: result.message, storeUrl: result.storeUrl };
        setVisible(true);
      }
    });
    return () => { cancelled = true; };
  }, []);

  const dismiss = useCallback(() => setVisible(false), []);

  const update = useCallback(() => {
    if (infoRef.current?.storeUrl) void Linking.openURL(infoRef.current.storeUrl);
    setVisible(false);
  }, []);

  if (!infoRef.current) return null;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={dismiss}>
      <TouchableWithoutFeedback onPress={dismiss}>
        <View style={styles.scrim} />
      </TouchableWithoutFeedback>
      <View style={styles.sheet}>
        <View style={styles.handle} />
        <View style={styles.top}>
          <View style={styles.iconCircle}>
            <Ionicons name="arrow-up" size={20} color={theme.brand} />
          </View>
          <View style={styles.textBlock}>
            <Text style={styles.title}>Update available</Text>
            <Text style={styles.copy}>{infoRef.current.message}</Text>
          </View>
          <TouchableOpacity style={styles.closeButton} onPress={dismiss} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Ionicons name="close" size={14} color={theme.inkMuted} />
          </TouchableOpacity>
        </View>
        <View style={styles.actions}>
          <TouchableOpacity style={styles.primaryButton} onPress={update} activeOpacity={0.85}>
            <Text style={styles.primaryButtonText}>Update</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.secondaryButton} onPress={dismiss}>
            <Text style={styles.secondaryButtonText}>Not now</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(10,16,12,0.45)' },
    sheet: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: theme.surface,
      borderTopLeftRadius: 22,
      borderTopRightRadius: 22,
      paddingHorizontal: 20,
      paddingTop: 10,
      paddingBottom: 26,
    },
    handle: { width: 36, height: 4, borderRadius: 2, backgroundColor: theme.border, alignSelf: 'center', marginBottom: 16 },
    top: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, marginBottom: 16 },
    iconCircle: {
      width: 40,
      height: 40,
      borderRadius: 12,
      backgroundColor: theme.brandSoft,
      alignItems: 'center',
      justifyContent: 'center',
    },
    textBlock: { flex: 1 },
    title: { fontSize: 15, fontWeight: '700', color: theme.ink, marginBottom: 4 },
    copy: { fontSize: 12.5, lineHeight: 18, color: theme.inkMuted },
    closeButton: {
      width: 26,
      height: 26,
      borderRadius: 13,
      backgroundColor: theme.surfaceRaised,
      alignItems: 'center',
      justifyContent: 'center',
    },
    actions: { flexDirection: 'row', gap: 10 },
    primaryButton: { flex: 1, backgroundColor: theme.brand, borderRadius: 12, paddingVertical: 13, alignItems: 'center' },
    primaryButtonText: { color: '#FFFFFF', fontSize: 13.5, fontWeight: '700' },
    secondaryButton: { paddingVertical: 13, paddingHorizontal: 14, alignItems: 'center' },
    secondaryButtonText: { color: theme.inkMuted, fontSize: 13, fontWeight: '600' },
  });
}
