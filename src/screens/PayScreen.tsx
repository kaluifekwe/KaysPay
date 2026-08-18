import React from 'react';
import { View, StyleSheet, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AppTheme } from '../constants/theme';
import { useTheme } from '../components/ThemeProvider';
import { Typography } from '../constants/typography';
import { Strings } from '../constants/strings';

export default function PayScreen() {
  const { theme } = useTheme();
  const styles = createStyles(theme);
  return (
    <SafeAreaView edges={['top']} style={styles.container}>
      <View style={styles.content}>
        <Text style={styles.title}>{Strings.SERVICE_AIRTIME}</Text>
        <Text style={styles.placeholder}>Coming in Phase 2</Text>
      </View>
    </SafeAreaView>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.background,
    },
    content: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
    },
    title: {
      ...Typography.SCREEN_TITLE,
      color: theme.ink,
      marginBottom: 8,
    },
    placeholder: {
      ...Typography.BODY,
      color: theme.inkMuted,
    },
  });
}
