import React, { useState, useRef, useEffect } from 'react';
import {
  View,
  StyleSheet,
  Dimensions,
  TouchableOpacity,
  Text,
  Animated,
  FlatList,
  SafeAreaView,
  StatusBar,
} from 'react-native';

const { width } = Dimensions.get('window');
const BRAND_GREEN = '#1A5C3A';
const DARK_BG = '#0F1A14';
const SLIDE_TITLE_COLOR = '#0F1A14';
const SLIDE_SUBTITLE_COLOR = '#6B7280';
const DOT_INACTIVE = '#D1D5DB';
const WHITE = '#FFFFFF';

interface WelcomeScreenProps {
  navigation: any;
}

const SmartRechargeSlide = () => (
  <View style={styles.slideIllustration}>
    <View style={styles.rechargeCard}>
      <View style={styles.rechargeHeaderRow}>
        <Text style={styles.rechargeHeaderTitle}>Quick Recharge</Text>
        <Text style={styles.rechargeHeaderCount}>4 contacts</Text>
      </View>
      <View style={styles.rechargeDivider} />
      <View style={styles.rechargeRow}>
        <View style={[styles.rechargeAvatar, { backgroundColor: '#E8F5E9' }]}><Text style={[styles.rechargeAvatarText, { color: BRAND_GREEN }]}>A</Text></View>
        <View style={styles.rechargeContactInfo}>
          <Text style={styles.rechargeContactName}>Amina Bello</Text>
          <Text style={styles.rechargeContactNumber}>0803 •••• 4521</Text>
        </View>
        <View style={styles.rechargeRight}>
          <View style={styles.rechargeNetworkBadge}><Text style={styles.rechargeNetworkBadgeText}>MTN</Text></View>
          <Text style={styles.rechargeAmount}>₦500</Text>
        </View>
      </View>
      <View style={styles.rechargeDivider} />
      <View style={styles.rechargeRow}>
        <View style={[styles.rechargeAvatar, { backgroundColor: '#E3F2FD' }]}><Text style={[styles.rechargeAvatarText, { color: '#1976D2' }]}>C</Text></View>
        <View style={styles.rechargeContactInfo}>
          <Text style={styles.rechargeContactName}>Chidi Okonkwo</Text>
          <Text style={styles.rechargeContactNumber}>0805 •••• 7832</Text>
        </View>
        <View style={styles.rechargeRight}>
          <View style={[styles.rechargeNetworkBadge, { backgroundColor: '#E3F2FD' }]}><Text style={[styles.rechargeNetworkBadgeText, { color: '#1976D2' }]}>Airtel</Text></View>
          <Text style={styles.rechargeAmount}>₦200</Text>
        </View>
      </View>
      <View style={styles.rechargeDivider} />
      <View style={styles.rechargeRow}>
        <View style={[styles.rechargeAvatar, { backgroundColor: '#FFF3E0' }]}><Text style={[styles.rechargeAvatarText, { color: '#E65100' }]}>F</Text></View>
        <View style={styles.rechargeContactInfo}>
          <Text style={styles.rechargeContactName}>Fatima Yusuf</Text>
          <Text style={styles.rechargeContactNumber}>0705 •••• 1947</Text>
        </View>
        <View style={styles.rechargeRight}>
          <View style={[styles.rechargeNetworkBadge, { backgroundColor: '#FBE9E7' }]}><Text style={[styles.rechargeNetworkBadgeText, { color: '#BF360C' }]}>Glo</Text></View>
          <Text style={styles.rechargeAmount}>₦1000</Text>
        </View>
      </View>
      <View style={styles.rechargeDivider} />
      <View style={styles.rechargeRow}>
        <View style={[styles.rechargeAvatar, { backgroundColor: '#E8F5E9' }]}><Text style={[styles.rechargeAvatarText, { color: BRAND_GREEN }]}>O</Text></View>
        <View style={styles.rechargeContactInfo}>
          <Text style={styles.rechargeContactName}>Ola Martins</Text>
          <Text style={styles.rechargeContactNumber}>0902 •••• 6218</Text>
        </View>
        <View style={styles.rechargeRight}>
          <View style={[styles.rechargeNetworkBadge, { backgroundColor: '#E8F5E9' }]}><Text style={[styles.rechargeNetworkBadgeText, { color: BRAND_GREEN }]}>Glo</Text></View>
          <Text style={styles.rechargeAmount}>₦500</Text>
        </View>
      </View>
    </View>
  </View>
);

const DollarCardSlide = () => (
  <View style={styles.slideIllustration}>
    <View style={styles.dollarCardShadow}>
      <View style={styles.dollarCard}>
        <View style={styles.dollarCardGlow} />
        <View style={styles.dollarCardContent}>
          <Text style={styles.dollarCardBrand}>Kay's Pay</Text>
          <View style={styles.dollarCardChip} />
          <Text style={styles.dollarCardNumber}>4782 •••• •••• 3947</Text>
          <View style={styles.dollarCardBottom}>
            <View>
              <Text style={styles.dollarCardHolder}>PREPAID</Text>
              <Text style={styles.dollarCardExpiry}>VALID THRU  12/27</Text>
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={styles.dollarCardVisa}>VISA</Text>
              <Text style={styles.dollarCardCvv}>CVV  •••</Text>
            </View>
          </View>
        </View>
      </View>
    </View>
  </View>
);

const ForeignNumbersSlide = () => (
  <View style={styles.slideIllustration}>
    <View style={styles.foreignCard}>
      <View style={styles.foreignRow}>
        <Text style={styles.foreignFlag}>🇺🇸</Text>
        <Text style={styles.foreignNumber}>+1 (202) 555-0147</Text>
        <View style={styles.foreignBadge}><Text style={styles.foreignBadgeText}>WhatsApp ✓</Text></View>
        <Text style={styles.foreignPrice}>₦500</Text>
      </View>
      <View style={styles.foreignDivider} />
      <View style={styles.foreignRow}>
        <Text style={styles.foreignFlag}>🇬🇧</Text>
        <Text style={styles.foreignNumber}>+44 7700 900142</Text>
        <View style={styles.foreignBadge}><Text style={styles.foreignBadgeText}>PayPal ✓</Text></View>
        <Text style={styles.foreignPrice}>₦600</Text>
      </View>
      <View style={styles.foreignDivider} />
      <View style={styles.foreignRow}>
        <Text style={styles.foreignFlag}>🇨🇦</Text>
        <Text style={styles.foreignNumber}>+1 (416) 555-0183</Text>
        <View style={styles.foreignBadge}><Text style={styles.foreignBadgeText}>Fiverr ✓</Text></View>
        <Text style={styles.foreignPrice}>₦450</Text>
      </View>
      <View style={styles.foreignBanner}>
        <Text style={styles.foreignBannerText}>✓ SMS code delivered instantly inside Kay's Pay</Text>
      </View>
    </View>
  </View>
);

const slides = [
  {
    id: '1',
    title: 'Recharge by Name',
    subtitle: 'Pick a contact, we detect the network. No typing.',
    Component: SmartRechargeSlide,
  },
  {
    id: '2',
    title: 'Your Dollar Card',
    subtitle: 'Fund from Naira, shop Amazon, Netflix, ChatGPT anywhere.',
    Component: DollarCardSlide,
  },
  {
    id: '3',
    title: 'Get a Foreign Number',
    subtitle: 'US, UK & Canada numbers for WhatsApp, PayPal, Fiverr and more.',
    Component: ForeignNumbersSlide,
  },
];

export default function WelcomeScreen({ navigation }: WelcomeScreenProps) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isAutoPlaying, setIsAutoPlaying] = useState(true);
  const scrollX = useRef(new Animated.Value(0)).current;
  const flatListRef = useRef<FlatList>(null);
  const autoScrollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const startAutoScroll = () => {
    if (autoScrollTimer.current) clearInterval(autoScrollTimer.current);
    autoScrollTimer.current = setInterval(() => {
      setCurrentIndex((prev) => {
        const next = (prev + 1) % slides.length;
        flatListRef.current?.scrollToOffset({ offset: next * width, animated: true });
        return next;
      });
    }, 3500);
  };

  const stopAutoScroll = () => {
    if (autoScrollTimer.current) clearInterval(autoScrollTimer.current);
  };

  useEffect(() => {
    if (isAutoPlaying) startAutoScroll();
    return () => stopAutoScroll();
  }, [isAutoPlaying]);

  const handleSignUp = () => navigation.navigate('Registration');
  const handleLogin = () => navigation.navigate('Login');

  const onViewableItemsChanged = useRef(({ viewableItems }: any) => {
    if (viewableItems.length > 0) {
      setCurrentIndex(viewableItems[0].index);
    }
  }).current;

  const viewabilityConfig = useRef({ viewAreaCoveragePercentThreshold: 50 }).current;

  const handleScrollBeginDrag = () => {
    setIsAutoPlaying(false);
    stopAutoScroll();
  };

  const handleScrollEndDrag = () => {
    setTimeout(() => setIsAutoPlaying(true), 5000);
  };

  const renderSlide = ({ item }: { item: typeof slides[0] }) => {
    const SlideComponent = item.Component;
    return (
      <View style={[styles.slide, { width }]}>
        <SlideComponent />
        <View style={styles.slideTextContainer}>
          <Text style={styles.slideTitle}>{item.title}</Text>
          <Text style={styles.slideSubtitle}>{item.subtitle}</Text>
        </View>
      </View>
    );
  };

  const renderDots = () => (
    <View style={styles.dotsContainer}>
      {slides.map((_, index) => {
        const isActive = index === currentIndex;
        return (
          <View
            key={index}
            style={[
              styles.dot,
              {
                width: isActive ? 24 : 8,
                backgroundColor: isActive ? BRAND_GREEN : DOT_INACTIVE,
              },
            ]}
          />
        );
      })}
    </View>
  );

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor={WHITE} />

      <View style={styles.header}>
        <View style={styles.logoCircle}>
          <Text style={styles.logoText}>K</Text>
        </View>
        <Text style={styles.appName}>Kay's Pay</Text>
        <Text style={styles.tagline}>Nigeria's All-in-One Payment App</Text>
      </View>

      <View style={styles.slidesContainer}>
        <Animated.FlatList
          ref={flatListRef as any}
          data={slides}
          renderItem={renderSlide}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          keyExtractor={(item) => item.id}
          onScroll={Animated.event(
            [{ nativeEvent: { contentOffset: { x: scrollX } } }],
            { useNativeDriver: false }
          )}
          onViewableItemsChanged={onViewableItemsChanged}
          viewabilityConfig={viewabilityConfig}
          onScrollBeginDrag={handleScrollBeginDrag}
          onScrollEndDrag={handleScrollEndDrag}
          getItemLayout={(_, index) => ({
            length: width,
            offset: width * index,
            index,
          })}
        />
        {renderDots()}
      </View>

      <View style={styles.bottomSection}>
        <TouchableOpacity style={styles.signUpButton} onPress={handleSignUp} activeOpacity={0.8}>
          <Text style={styles.signUpText}>Sign Up</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.loginButton} onPress={handleLogin} activeOpacity={0.8}>
          <Text style={styles.loginText}>Login</Text>
        </TouchableOpacity>

        <Text style={styles.terms}>
          By continuing, you agree to our Terms of Service and Privacy Policy.
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: WHITE,
  },
  header: {
    alignItems: 'center',
    paddingTop: 32,
    paddingBottom: 8,
  },
  logoCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: BRAND_GREEN,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 10,
    shadowColor: BRAND_GREEN,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 6,
  },
  logoText: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 30,
    color: WHITE,
  },
  appName: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 26,
    color: SLIDE_TITLE_COLOR,
    marginBottom: 2,
  },
  tagline: {
    fontSize: 13,
    color: SLIDE_SUBTITLE_COLOR,
  },
  slidesContainer: {
    flex: 1,
    minHeight: 0,
  },
  slide: {
    alignItems: 'center',
    justifyContent: 'flex-start',
    paddingHorizontal: 24,
    paddingTop: 16,
  },
  slideIllustration: {
    width: width - 48,
    height: width * 0.65,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 8,
  },
  slideTextContainer: {
    alignItems: 'center',
    paddingHorizontal: 16,
  },
  slideTitle: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 22,
    color: SLIDE_TITLE_COLOR,
    textAlign: 'center',
    marginBottom: 8,
  },
  slideSubtitle: {
    fontSize: 14,
    color: SLIDE_SUBTITLE_COLOR,
    textAlign: 'center',
    lineHeight: 20,
    numberOfLines: 2,
  } as any,

  dotsContainer: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 8,
  },
  dot: {
    height: 8,
    borderRadius: 4,
    marginHorizontal: 4,
  },

  bottomSection: {
    paddingHorizontal: 24,
    paddingBottom: 24,
  },
  signUpButton: {
    height: 52,
    backgroundColor: BRAND_GREEN,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 10,
  },
  signUpText: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 16,
    color: WHITE,
  },
  loginButton: {
    height: 52,
    borderWidth: 2,
    borderColor: BRAND_GREEN,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 12,
  },
  loginText: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 16,
    color: BRAND_GREEN,
  },
  terms: {
    fontSize: 11,
    color: '#9CA3AF',
    textAlign: 'center',
    lineHeight: 16,
  },

  rechargeCard: {
    width: width - 48,
    backgroundColor: WHITE,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 6,
    elevation: 2,
  },
  rechargeHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  rechargeHeaderTitle: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 13,
    color: SLIDE_TITLE_COLOR,
  },
  rechargeHeaderCount: {
    fontSize: 11,
    color: SLIDE_SUBTITLE_COLOR,
  },
  rechargeDivider: {
    height: 0.5,
    backgroundColor: '#E5E7EB',
    marginHorizontal: 16,
  },
  rechargeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    minHeight: 56,
  },
  rechargeAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  rechargeAvatarText: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 14,
  },
  rechargeContactInfo: {
    flex: 1,
  },
  rechargeContactName: {
    fontSize: 13,
    fontWeight: '600',
    color: SLIDE_TITLE_COLOR,
    marginBottom: 2,
  },
  rechargeContactNumber: {
    fontSize: 10,
    color: '#9CA3AF',
    letterSpacing: 0.5,
  },
  rechargeRight: {
    alignItems: 'flex-end',
  },
  rechargeNetworkBadge: {
    backgroundColor: '#E8F5E9',
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 4,
    marginBottom: 4,
  },
  rechargeNetworkBadgeText: {
    fontSize: 9,
    fontWeight: '700',
    color: BRAND_GREEN,
    letterSpacing: 0.5,
  },
  rechargeAmount: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 13,
    color: BRAND_GREEN,
  },

  dollarCard: {
    width: width - 48,
    height: (width - 48) * 0.6,
    borderRadius: 16,
    overflow: 'hidden',
  },
  dollarCardShadow: {
    shadowColor: BRAND_GREEN,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.3,
    shadowRadius: 20,
    elevation: 8,
  },
  dollarCardGlow: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: DARK_BG,
    borderRadius: 16,
    shadowColor: BRAND_GREEN,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.5,
    shadowRadius: 20,
    elevation: 8,
  },
  dollarCardContent: {
    flex: 1,
    backgroundColor: DARK_BG,
    borderRadius: 16,
    padding: 20,
    justifyContent: 'space-between',
  },
  dollarCardBrand: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 16,
    color: WHITE,
    letterSpacing: 0.5,
  },
  dollarCardChip: {
    width: 36,
    height: 28,
    borderRadius: 6,
    backgroundColor: '#C9A84C',
    marginTop: 8,
  },
  dollarCardNumber: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 18,
    color: WHITE,
    letterSpacing: 2,
    marginTop: 8,
  },
  dollarCardBottom: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
  },
  dollarCardHolder: {
    fontSize: 10,
    color: '#9CA3AF',
    letterSpacing: 1,
  },
  dollarCardExpiry: {
    fontSize: 10,
    color: WHITE,
    letterSpacing: 1,
    marginTop: 2,
  },
  dollarCardCvv: {
    fontSize: 10,
    color: '#9CA3AF',
    letterSpacing: 1,
    marginTop: 2,
  },
  dollarCardVisa: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 20,
    color: WHITE,
    fontStyle: 'italic',
  },

  foreignCard: {
    width: width - 48,
    backgroundColor: WHITE,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    padding: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 6,
    elevation: 2,
  },
  foreignRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
  },
  foreignFlag: {
    fontSize: 24,
    marginRight: 8,
  },
  foreignNumber: {
    flex: 1,
    fontFamily: 'Helvetica-Bold',
    fontSize: 13,
    color: SLIDE_TITLE_COLOR,
  },
  foreignBadge: {
    backgroundColor: BRAND_GREEN,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
    marginRight: 8,
  },
  foreignBadgeText: {
    fontSize: 10,
    fontWeight: '700',
    color: WHITE,
  },
  foreignPrice: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 13,
    color: BRAND_GREEN,
    minWidth: 40,
    textAlign: 'right',
  },
  foreignDivider: {
    height: 1,
    backgroundColor: '#F0F0F0',
    marginHorizontal: 4,
  },
  foreignBanner: {
    backgroundColor: '#D6F0E3',
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    marginTop: 12,
  },
  foreignBannerText: {
    fontSize: 11,
    color: BRAND_GREEN,
    textAlign: 'center',
  },
});
