import React from 'react';
import { View, StyleSheet, Text, SafeAreaView } from 'react-native';
import { Colors } from '../constants/colors';
import { Typography } from '../constants/typography';
import { Strings } from '../constants/strings';

export default function MoreScreen() {
  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <Text style={styles.title}>More</Text>
        <Text style={styles.placeholder}>Coming in Phase 5</Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.WHITE,
  },
  content: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  title: {
    ...Typography.SCREEN_TITLE,
    marginBottom: 8,
  },
  placeholder: {
    ...Typography.BODY,
    color: Colors.GRAY,
  },
});
