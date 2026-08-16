import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, Easing, Image, StyleSheet, Text, TouchableOpacity, View, AccessibilityInfo } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Colors } from '../constants/colors';

const PERSON_IMAGE = require('../assets/promo-data-person.png');

const WORDS = ['Save', 'More', 'on', 'every', 'plan'];
const WORD_DELAYS_MS = [100, 280, 500, 660, 820];
const WORD_DURATION_MS = 320;

const ACCENT_DELAY_MS = 1050;
const SUB_DELAY_MS = 1450;
const BADGE_DISCOUNT_DELAY_MS = 1850;
const BADGE_CASHBACK_DELAY_MS = 2050;
const PHOTO_DELAY_MS = 2450;
const CTA_DELAY_MS = 2750;
const LINE_DURATION_MS = 500;
const BADGE_DURATION_MS = 450;
const PHOTO_DURATION_MS = 550;
const CTA_DURATION_MS = 400;

const BUILD_MS = 3200;
const HOLD_MS = 2000;
const FADE_MS = 400;
const GAP_MS = 300;
const CYCLE_MS = BUILD_MS + HOLD_MS + FADE_MS + GAP_MS;

interface DataPromoBannerProps {
  navigation: any;
}

// Discount + cashback promo card. Builds up word by word, holds, fades, and
// repeats on its own while Home is focused (owner-approved motion, 2026-08-16).
// Loop pauses on blur and collapses to a single fade for reduced-motion users
// — see useFocusEffect/AccessibilityInfo below.
export default function DataPromoBanner({ navigation }: DataPromoBannerProps) {
  const [reduceMotion, setReduceMotion] = useState(false);
  const groupOpacity = useRef(new Animated.Value(1)).current;
  const wordAnims = useRef(WORDS.map(() => new Animated.Value(0))).current;
  const accentAnim = useRef(new Animated.Value(0)).current;
  const subAnim = useRef(new Animated.Value(0)).current;
  const badgeDiscountAnim = useRef(new Animated.Value(0)).current;
  const badgeCashbackAnim = useRef(new Animated.Value(0)).current;
  const photoAnim = useRef(new Animated.Value(0)).current;
  const ctaAnim = useRef(new Animated.Value(0)).current;

  const loopTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runningRef = useRef(false);

  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled?.().then(setReduceMotion).catch(() => {});
  }, []);

  const allAnims = [
    accentAnim,
    subAnim,
    badgeDiscountAnim,
    badgeCashbackAnim,
    photoAnim,
    ctaAnim,
    ...wordAnims,
  ];

  const resetAnims = useCallback(() => {
    groupOpacity.setValue(1);
    allAnims.forEach((v) => v.setValue(0));
  }, []);

  const buildIn = useCallback(() => {
    const timings = [
      ...wordAnims.map((v, i) =>
        Animated.timing(v, {
          toValue: 1,
          duration: WORD_DURATION_MS,
          delay: WORD_DELAYS_MS[i],
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        })
      ),
      Animated.timing(accentAnim, {
        toValue: 1,
        duration: LINE_DURATION_MS,
        delay: ACCENT_DELAY_MS,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(subAnim, {
        toValue: 1,
        duration: LINE_DURATION_MS,
        delay: SUB_DELAY_MS,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(badgeDiscountAnim, {
        toValue: 1,
        duration: BADGE_DURATION_MS,
        delay: BADGE_DISCOUNT_DELAY_MS,
        easing: Easing.out(Easing.back(1.4)),
        useNativeDriver: true,
      }),
      Animated.timing(badgeCashbackAnim, {
        toValue: 1,
        duration: BADGE_DURATION_MS,
        delay: BADGE_CASHBACK_DELAY_MS,
        easing: Easing.out(Easing.back(1.4)),
        useNativeDriver: true,
      }),
      Animated.timing(photoAnim, {
        toValue: 1,
        duration: PHOTO_DURATION_MS,
        delay: PHOTO_DELAY_MS,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(ctaAnim, {
        toValue: 1,
        duration: CTA_DURATION_MS,
        delay: CTA_DELAY_MS,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ];
    Animated.parallel(timings).start();
  }, []);

  const runLoop = useCallback(() => {
    if (reduceMotion) {
      resetAnims();
      buildIn();
      return;
    }
    runningRef.current = true;
    const step = () => {
      if (!runningRef.current) return;
      resetAnims();
      buildIn();
      loopTimer.current = setTimeout(() => {
        if (!runningRef.current) return;
        Animated.timing(groupOpacity, {
          toValue: 0,
          duration: FADE_MS,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }).start();
        loopTimer.current = setTimeout(() => {
          if (runningRef.current) step();
        }, HOLD_MS + FADE_MS + GAP_MS - HOLD_MS);
      }, BUILD_MS + HOLD_MS);
    };
    step();
  }, [reduceMotion]);

  useFocusEffect(
    useCallback(() => {
      runLoop();
      return () => {
        runningRef.current = false;
        if (loopTimer.current) clearTimeout(loopTimer.current);
      };
    }, [runLoop])
  );

  const wordStyle = (v: Animated.Value) => ({
    opacity: v,
    transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) }],
  });
  const slideLeftStyle = (v: Animated.Value) => ({
    opacity: v,
    transform: [{ translateX: v.interpolate({ inputRange: [0, 1], outputRange: [-16, 0] }) }],
  });
  const dropStyle = (v: Animated.Value) => ({
    opacity: v,
    transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [-16, 0] }) }],
  });
  const slideRightStyle = (v: Animated.Value) => ({
    opacity: v,
    transform: [{ translateX: v.interpolate({ inputRange: [0, 1], outputRange: [16, 0] }) }],
  });
  const revealStyle = (v: Animated.Value) => ({
    opacity: v,
    transform: [{ scale: v.interpolate({ inputRange: [0, 1], outputRange: [0.88, 1] }) }],
  });

  return (
    <TouchableOpacity
      style={styles.card}
      activeOpacity={0.92}
      onPress={() => navigation.navigate('Data')}
    >
      <View style={[styles.orb, styles.orbA]} />
      <View style={[styles.orb, styles.orbB]} />

      <Animated.View style={[styles.inner, { opacity: groupOpacity }]}>
        <View style={styles.copy}>
          <View style={styles.headlineRow}>
            {WORDS.slice(0, 2).map((w, i) => (
              <Animated.Text key={w} style={[styles.headline, wordStyle(wordAnims[i]), styles.wordSpacing]}>
                {w}
              </Animated.Text>
            ))}
          </View>
          <View style={styles.headlineRow}>
            {WORDS.slice(2).map((w, i) => (
              <Animated.Text key={w} style={[styles.headline, wordStyle(wordAnims[i + 2]), styles.wordSpacing]}>
                {w}
              </Animated.Text>
            ))}
          </View>
          <Animated.Text style={[styles.accent, slideLeftStyle(accentAnim)]}>Data &amp; more</Animated.Text>
          <Animated.Text style={[styles.sub, slideLeftStyle(subAnim)]}>
            Automatic discount on every purchase, plus cashback on top.
          </Animated.Text>
          <View style={styles.badgeRow}>
            <Animated.View style={[styles.badge, styles.badgeDiscount, dropStyle(badgeDiscountAnim)]}>
              <Text style={styles.badgeDiscountText}>Instant Discount</Text>
            </Animated.View>
            <Animated.View style={[styles.badge, styles.badgeCashback, slideRightStyle(badgeCashbackAnim)]}>
              <Text style={styles.badgeCashbackText}>+ Cashback</Text>
            </Animated.View>
          </View>
        </View>

        <Animated.Image
          source={PERSON_IMAGE}
          resizeMode="contain"
          style={[styles.photo, revealStyle(photoAnim)]}
        />

        <Animated.View style={[styles.cta, { opacity: ctaAnim }]}>
          <Text style={styles.ctaText}>Buy Data Now</Text>
        </Animated.View>
      </Animated.View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 18,
    overflow: 'hidden',
    backgroundColor: Colors.GREEN,
    height: 220,
    marginBottom: 16,
  },
  orb: {
    position: 'absolute',
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.07)',
  },
  orbA: { width: 150, height: 150, top: -55, right: -30 },
  orbB: { width: 115, height: 115, bottom: -55, left: -30, backgroundColor: 'rgba(255,255,255,0.05)' },
  inner: {
    flex: 1,
  },
  copy: {
    paddingTop: 17,
    paddingLeft: 17,
    width: '62%',
  },
  headlineRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  headline: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 20,
    lineHeight: 23,
    color: Colors.WHITE,
  },
  wordSpacing: {
    marginRight: 6,
  },
  accent: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 20,
    lineHeight: 23,
    color: Colors.AMBER,
    marginTop: 2,
  },
  sub: {
    fontFamily: 'Helvetica',
    fontSize: 11.5,
    lineHeight: 16,
    color: 'rgba(255,255,255,0.82)',
    marginTop: 7,
    maxWidth: 190,
  },
  badgeRow: {
    flexDirection: 'row',
    marginTop: 12,
  },
  badge: {
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 20,
    marginRight: 6,
  },
  badgeDiscount: { backgroundColor: Colors.WHITE },
  badgeDiscountText: { fontFamily: 'Helvetica-Bold', fontSize: 10.5, color: Colors.GREEN_DARK },
  badgeCashback: { backgroundColor: Colors.AMBER },
  badgeCashbackText: { fontFamily: 'Helvetica-Bold', fontSize: 10.5, color: Colors.GREEN_DARK },
  photo: {
    position: 'absolute',
    right: -6,
    bottom: -8,
    width: 190,
    height: 190,
  },
  cta: {
    position: 'absolute',
    left: 17,
    bottom: 16,
    backgroundColor: Colors.AMBER,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
  },
  ctaText: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 12,
    color: Colors.GREEN_DARK,
  },
});
