import React, { useState } from 'react';
import { View, Text, Image } from 'react-native';
import { Typography } from '../constants/typography';
import { Spacing } from '../constants/spacing';
import { useTheme } from './ThemeProvider';

// Not every bank in the list has a logo (the free public source only covers
// the major institutions) — falls back to a plain initial badge rather than
// a broken image, and to a real image if a fetched one fails to load.
export default function BankLogoIcon({ bank, size }: { bank: { name: string; logo?: string }; size: number }) {
  const { theme } = useTheme();
  const [failed, setFailed] = useState(false);
  const showImage = !!bank.logo && !failed;
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        overflow: 'hidden',
        backgroundColor: theme.surfaceRaised,
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: Spacing.S,
      }}
    >
      {showImage ? (
        <Image
          source={{ uri: bank.logo }}
          style={{ width: size, height: size }}
          resizeMode="contain"
          onError={() => setFailed(true)}
        />
      ) : (
        <Text style={{ ...Typography.CAPTION, color: theme.inkMuted, fontWeight: '700' }}>
          {bank.name.charAt(0).toUpperCase()}
        </Text>
      )}
    </View>
  );
}
