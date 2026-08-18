import React from 'react';
import { View, Text, Image, StyleSheet, ImageSourcePropType, StyleProp, ViewStyle } from 'react-native';
import { useTheme } from './ThemeProvider';

interface ProviderLogoProps {
  /** The real logo image, when we have one. Falls back to an initials badge otherwise. */
  source?: ImageSourcePropType;
  fallbackLabel: string;
  size?: number;
  fallbackColor?: string;
  style?: StyleProp<ViewStyle>;
}

function initialsOf(label: string): string {
  const parts = label.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

export default function ProviderLogo({
  source,
  fallbackLabel,
  size = 36,
  fallbackColor,
  style,
}: ProviderLogoProps) {
  const { theme } = useTheme();
  const styles = createStyles(theme);
  const dim = { width: size, height: size, borderRadius: size / 2 };
  // Scale padding with size so small badges don't lose most of their area to
  // a fixed inset (a flat 4px eats ~35% of a 22px circle but barely any of a 44px one).
  const padding = Math.max(1, Math.round(size * 0.08));

  if (!source) {
    return (
      <View style={[styles.fallback, dim, { backgroundColor: fallbackColor ?? theme.brand }, style]}>
        <Text style={[styles.fallbackText, { fontSize: size * 0.32 }]}>
          {initialsOf(fallbackLabel)}
        </Text>
      </View>
    );
  }

  return (
    <View style={[styles.wrap, dim, { padding }, style]}>
      <Image source={source} style={styles.image} resizeMode="contain" />
    </View>
  );
}

function createStyles(theme: import('../constants/theme').AppTheme) {
  return StyleSheet.create({
  wrap: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: theme.border,
    justifyContent: 'center',
    alignItems: 'center',
    overflow: 'hidden',
  },
  image: {
    width: '100%',
    height: '100%',
  },
  fallback: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  fallbackText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontFamily: 'Helvetica-Bold',
  },
  });
}
