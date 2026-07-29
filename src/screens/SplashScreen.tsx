import React, { useEffect, useRef } from 'react';
import {
  View,
  StyleSheet,
  Animated,
  Dimensions,
  StatusBar,
  Image,
} from 'react-native';
import { Colors } from '../constants/colors';
import { isAuthenticated } from '../lib/supabase';
import { StorageKeys, storageHelpers } from '../lib/mmkv';

const { width } = Dimensions.get('window');

interface SplashScreenProps {
  navigation: any;
}

export default function SplashScreen({ navigation }: SplashScreenProps) {
  const scaleAnim = useRef(new Animated.Value(0.5)).current;
  const opacityAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.sequence([
      Animated.parallel([
        Animated.spring(scaleAnim, {
          toValue: 1,
          tension: 50,
          friction: 7,
          useNativeDriver: true,
        }),
        Animated.timing(opacityAnim, {
          toValue: 1,
          duration: 500,
          useNativeDriver: true,
        }),
      ]),
      Animated.delay(1000),
    ]).start(() => {
      checkAuthAndNavigate();
    });
  }, []);

  const checkAuthAndNavigate = async () => {
    try {
      const [authenticated, onboardingCompleted] = await Promise.all([
        isAuthenticated().catch(() => false),
        storageHelpers.getBoolean(StorageKeys.ONBOARDING_COMPLETED).catch(() => undefined),
      ]);

      if (!onboardingCompleted) {
        navigation.replace('Welcome');
      } else if (!authenticated) {
        navigation.replace('PhoneInput');
      }
      // If authenticated, AppNavigator will automatically show Main
    } catch (error) {
      navigation.replace('Welcome');
    }
  };

  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor={Colors.WHITE} />
      <Animated.View
        style={[
          styles.logoContainer,
          {
            transform: [{ scale: scaleAnim }],
            opacity: opacityAnim,
          },
        ]}
      >
        <View style={styles.logoTile}>
          <Image source={require('../../assets/icon.png')} style={styles.logoImg} resizeMode="contain" />
        </View>
        <Animated.Text style={styles.appName}>Kay's Pay</Animated.Text>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.WHITE,
    justifyContent: 'center',
    alignItems: 'center',
  },
  logoContainer: {
    alignItems: 'center',
  },
  logoTile: {
    width: 160,
    height: 160,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 16,
  },
  logoImg: {
    width: 150,
    height: 150,
  },
  appName: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 28,
    color: Colors.GREEN,
    letterSpacing: 1,
  },
});
