import React, { useState, useRef, useEffect } from 'react';
import {
  View,
  StyleSheet,
  Dimensions,
  TouchableOpacity,
  Text,
  Animated,
  FlatList,
  StatusBar,
  Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';

const { width } = Dimensions.get('window');
// This whole screen is a fixed brand-green marketing carousel (the first
// thing anyone sees, before any theme preference exists) — same reasoning as
// AppPrivacyGate's coverSplash and the physical-card mockups elsewhere: its
// white text/buttons/dots are designed around always sitting on this dark
// green backdrop, not a neutral surface that should track the app theme.
// Deliberately NOT converted to theme tokens.
const BRAND_GREEN = '#1A5C3A';
const DARK_BG = '#0F1A14';
const SCREEN_BG = '#123626';
// Text color inside the WHITE inner cards (recharge list, foreign numbers) —
// unrelated to the page background, kept dark for contrast on those cards.
const SLIDE_TITLE_COLOR = '#0F1A14';
const SLIDE_SUBTITLE_COLOR = '#6B7280';
// Text color directly on the dark page background (header, slide title/subtitle).
const PAGE_TEXT_PRIMARY = '#FFFFFF';
const PAGE_TEXT_SECONDARY = 'rgba(255,255,255,0.75)';
const DOT_INACTIVE = 'rgba(255,255,255,0.35)';
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

const AirtimeSlide = () => (
  <View style={styles.slideIllustration}>
    <View style={styles.illoPanel}>
      <View style={styles.airtimeRow}>
        <View style={styles.netStack}>
          <View style={[styles.netDot, { backgroundColor: '#FFCB00' }]}><Text style={[styles.netDotText, { color: '#5B4A00' }]}>MTN</Text></View>
          <View style={[styles.netDot, { backgroundColor: '#ED1C24' }]}><Text style={[styles.netDotText, { color: WHITE }]}>Airtel</Text></View>
          <View style={[styles.netDot, { backgroundColor: '#1A6B3A' }]}><Text style={[styles.netDotText, { color: WHITE }]}>Glo</Text></View>
        </View>
        <View style={styles.phone}>
          <View style={styles.phoneScreen}>
            <Ionicons name="cellular" size={18} color={BRAND_GREEN} />
            <Text style={styles.phoneAmount}>+₦500</Text>
          </View>
          <View style={styles.phoneHome} />
        </View>
      </View>
    </View>
  </View>
);

const DataSlide = () => (
  <View style={styles.slideIllustration}>
    <View style={styles.illoPanel}>
      <View style={styles.dataCard}>
        <View style={styles.flexOne}>
          <Text style={styles.dataGb}>2GB</Text>
          <Text style={styles.dataMeta}>30 days  ·  ₦730</Text>
        </View>
        <Ionicons name="wifi" size={30} color="#BFE0CC" />
      </View>
      <View style={styles.barsRow}>
        <View style={[styles.bar, { height: 16 }]} />
        <View style={[styles.bar, { height: 26 }]} />
        <View style={[styles.bar, { height: 36 }]} />
        <View style={[styles.bar, { height: 46, backgroundColor: '#C79A3A' }]} />
      </View>
    </View>
  </View>
);

const EsimSlide = () => (
  <View style={styles.slideIllustration}>
    <View style={styles.illoPanel}>
      <View style={styles.esimRow}>
        <Ionicons name="globe-outline" size={104} color={BRAND_GREEN} />
        <View style={styles.simChip}>
          <View style={styles.simInner} />
        </View>
      </View>
      <View style={styles.esimBadge}>
        <Ionicons name="location-sharp" size={13} color={WHITE} />
        <Text style={styles.esimBadgeText}>190+ countries</Text>
      </View>
    </View>
  </View>
);

const NinSlide = () => (
  <View style={styles.slideIllustration}>
    <View style={styles.illoPanel}>
      <View style={styles.ninCard}>
        <View style={styles.ninHeader}><Text style={styles.ninHeaderText}>DIGITAL NIN SLIP</Text></View>
        <View style={styles.ninBody}>
          <View style={styles.ninAvatar}><Ionicons name="person" size={20} color={BRAND_GREEN} /></View>
          <View style={styles.ninLines}>
            <View style={styles.ninLine} />
            <View style={[styles.ninLine, { width: '55%', backgroundColor: '#A9C6B4' }]} />
            <Text style={styles.ninNumber}>{'•••• •••• 040'}</Text>
          </View>
        </View>
      </View>
    </View>
  </View>
);

const slides = [
  {
    id: '1',
    title: 'Airtime in seconds',
    subtitle: 'Top up any network instantly — for you, friends, or as a reseller.',
    Component: AirtimeSlide,
  },
  {
    id: '2',
    title: 'Data that lasts',
    subtitle: 'Affordable bundles for every network, delivered the moment you pay.',
    Component: DataSlide,
  },
  {
    id: '3',
    title: 'Travel eSIMs',
    subtitle: 'Stay online abroad with instant eSIMs for 190+ countries.',
    Component: EsimSlide,
  },
  {
    id: '4',
    title: 'NIN & BVN verification',
    subtitle: 'Verify your NIN or BVN and download the slip in seconds.',
    Component: NinSlide,
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
                backgroundColor: isActive ? WHITE : DOT_INACTIVE,
              },
            ]}
          />
        );
      })}
    </View>
  );

  return (
    <SafeAreaView edges={['top']} style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor={SCREEN_BG} />

      <View style={styles.header}>
        <View style={styles.logoTile}>
          <Image source={require('../../assets/icon-green.png')} style={styles.logoImg} resizeMode="contain" />
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
      </View>
      {renderDots()}

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
    backgroundColor: SCREEN_BG,
  },
  header: {
    alignItems: 'center',
    paddingTop: 32,
    paddingBottom: 8,
  },
  logoTile: {
    width: 64,
    height: 64,
    borderRadius: 16,
    backgroundColor: WHITE,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 10,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.12,
    shadowRadius: 6,
    elevation: 4,
  },
  logoImg: {
    width: 64,
    height: 64,
  },
  appName: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 26,
    color: PAGE_TEXT_PRIMARY,
    marginBottom: 2,
  },
  tagline: {
    fontSize: 13,
    color: PAGE_TEXT_SECONDARY,
  },
  slidesContainer: {
    flex: 1,
    minHeight: 0,
    // 'flex-end' (not 'center') deliberately sends all the leftover vertical
    // space to the TOP of this block instead of splitting it evenly above
    // and below the slide — that's what previously left a large empty gap
    // between the dots and the Sign Up/Login buttons. Pinning to the bottom
    // means the dots (now rendered as their own sibling right after this
    // View, not inside it) sit directly under the slide with no extra gap.
    justifyContent: 'flex-end',
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
    color: PAGE_TEXT_PRIMARY,
    textAlign: 'center',
    marginBottom: 8,
  },
  slideSubtitle: {
    fontSize: 14,
    color: PAGE_TEXT_SECONDARY,
    textAlign: 'center',
    lineHeight: 20,
    numberOfLines: 2,
  } as any,

  illoPanel: {
    width: '100%',
    height: '100%',
    backgroundColor: '#E7F1EA',
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  flexOne: { flex: 1 },
  airtimeRow: { flexDirection: 'row', alignItems: 'center', gap: 22 },
  netStack: { gap: 12 },
  netDot: { width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center' },
  netDotText: { fontSize: 9, fontWeight: '700' },
  phone: { width: 96, height: 156, borderRadius: 22, backgroundColor: BRAND_GREEN, alignItems: 'center', justifyContent: 'center', gap: 10 },
  phoneScreen: { width: 74, height: 108, borderRadius: 10, backgroundColor: WHITE, alignItems: 'center', justifyContent: 'center', gap: 6 },
  phoneAmount: { fontSize: 17, fontWeight: '800', color: BRAND_GREEN },
  phoneHome: { width: 34, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.6)' },
  dataCard: { flexDirection: 'row', alignItems: 'center', width: 210, backgroundColor: BRAND_GREEN, borderRadius: 16, padding: 16 },
  dataGb: { fontSize: 28, fontWeight: '800', color: WHITE },
  dataMeta: { fontSize: 12, color: '#C7E0D1', marginTop: 3 },
  barsRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 9, marginTop: 20, height: 46 },
  bar: { width: 13, borderRadius: 3, backgroundColor: BRAND_GREEN },
  esimRow: { flexDirection: 'row', alignItems: 'center' },
  simChip: { width: 48, height: 58, borderRadius: 12, backgroundColor: '#C79A3A', alignItems: 'center', justifyContent: 'center', marginLeft: -10 },
  simInner: { width: 28, height: 22, borderRadius: 5, backgroundColor: WHITE },
  esimBadge: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: BRAND_GREEN, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 7, marginTop: 18 },
  esimBadgeText: { color: WHITE, fontSize: 12, fontWeight: '600' },
  ninCard: { width: 230, backgroundColor: WHITE, borderRadius: 12, borderWidth: 1.5, borderColor: BRAND_GREEN, overflow: 'hidden' },
  ninHeader: { backgroundColor: BRAND_GREEN, paddingVertical: 7, alignItems: 'center' },
  ninHeaderText: { color: WHITE, fontSize: 9, fontWeight: '700', letterSpacing: 1 },
  ninBody: { flexDirection: 'row', alignItems: 'center', padding: 14 },
  ninAvatar: { width: 42, height: 42, borderRadius: 21, backgroundColor: '#E7F1EA', borderWidth: 1, borderColor: BRAND_GREEN, alignItems: 'center', justifyContent: 'center' },
  ninLines: { flex: 1, marginLeft: 14 },
  ninLine: { height: 7, borderRadius: 4, backgroundColor: BRAND_GREEN, width: '85%', marginBottom: 7 },
  ninNumber: { fontSize: 12, fontWeight: '700', letterSpacing: 2, color: BRAND_GREEN, marginTop: 4 },

  dotsContainer: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    paddingTop: 8,
    paddingBottom: 16,
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
    backgroundColor: WHITE,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 10,
  },
  signUpText: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 16,
    color: BRAND_GREEN,
  },
  loginButton: {
    height: 52,
    borderWidth: 2,
    borderColor: WHITE,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 12,
  },
  loginText: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 16,
    color: WHITE,
  },
  terms: {
    fontSize: 11,
    color: 'rgba(255,255,255,0.6)',
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
