import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  Alert,
  ActivityIndicator,
  StyleSheet,
  Keyboard,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AppTheme } from '../constants/theme';
import { useTheme } from '../components/ThemeProvider';
import { Typography } from '../constants/typography';
import { Spacing } from '../constants/spacing';

import { formatNaira } from '../utils/formatCurrency';
import { formatUSD } from '../utils/formatCurrency';
import { logger } from '../services/logger.service';

interface DollarCardsScreenProps {
  navigation: {
    goBack: () => void;
  };
}

interface CardTransaction {
  id: string;
  description: string;
  amount: number;
  type: 'credit' | 'debit';
  date: string;
  status: 'completed' | 'pending' | 'failed';
}

const MOCK_CARD = {
  number: '**** **** **** 4829',
  holder: "KAYSPAY USER",
  expiry: '12/28',
  balance: 0,
};

const MOCK_TRANSACTIONS: CardTransaction[] = [
  {
    id: '1',
    description: 'Netflix Subscription',
    amount: 15.99,
    type: 'debit',
    date: '2026-06-25',
    status: 'completed',
  },
  {
    id: '2',
    description: 'Card Funded',
    amount: 100.0,
    type: 'credit',
    date: '2026-06-20',
    status: 'completed',
  },
  {
    id: '3',
    description: 'Spotify Premium',
    amount: 9.99,
    type: 'debit',
    date: '2026-06-18',
    status: 'completed',
  },
];

export default function DollarCardsScreen({ navigation }: DollarCardsScreenProps) {
  const { theme } = useTheme();
  const styles = createStyles(theme);
  const [isFrozen, setIsFrozen] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [transactions, setTransactions] = useState<CardTransaction[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const card = MOCK_CARD;

  useEffect(() => {
    logger.logView('dollar_card');

    const loadTransactions = async () => {
      setIsLoading(true);
      try {
        setTransactions([]);
      } catch {
        logger.logFailure('dollar_card', null, { action: 'load_transactions' });
        setTransactions([]);
      } finally {
        setIsLoading(false);
      }
    };

    loadTransactions();
  }, []);

  const handleFundCard = useCallback(() => {
    Alert.alert(
      'Fund Card',
      'Card funding will be available soon. You can fund your dollar card from your wallet balance.',
      [{ text: 'OK' }],
    );
  }, []);

  const handleFreezeCard = useCallback(() => {
    Alert.alert(
      isFrozen ? 'Unfreeze Card' : 'Freeze Card',
      isFrozen
        ? 'Are you sure you want to unfreeze your card?'
        : 'Are you sure you want to freeze your card? This will temporarily disable all transactions.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: isFrozen ? 'Unfreeze' : 'Freeze',
          onPress: () => {
            setIsFrozen((prev) => !prev);
            logger.logAttempt('dollar_card', null, {
              action: isFrozen ? 'unfreeze' : 'freeze',
            });
          },
        },
      ],
    );
  }, [isFrozen]);

  const handleCardDetails = useCallback(() => {
    setShowDetails((prev) => !prev);
  }, []);

  const handleCreateCard = useCallback(() => {
    Alert.alert(
      'Create New Card',
      'Virtual dollar card creation will be available soon. You will be able to create a new card for international transactions.',
      [{ text: 'OK' }],
    );
  }, []);

  const handleConvertUsdt = useCallback(() => {
    Alert.alert(
      'Coming Soon',
      'Converting USDT to Naira, and receiving USDT directly, will be available here soon.',
      [{ text: 'OK' }],
    );
  }, []);

  const renderTransaction = ({ item }: { item: CardTransaction }) => (
    <View style={styles.transactionItem}>
      <View style={styles.transactionLeft}>
        <View
          style={[
            styles.transactionIcon,
            { backgroundColor: item.type === 'credit' ? theme.brandSoft : theme.surfaceRaised },
          ]}
        >
          <Text
            style={[
              styles.transactionIconText,
              { color: item.type === 'credit' ? theme.brand : theme.ink },
            ]}
          >
            {item.type === 'credit' ? '+' : '-'}
          </Text>
        </View>
        <View style={styles.transactionInfo}>
          <Text style={styles.transactionDescription}>{item.description}</Text>
          <Text style={styles.transactionDate}>{item.date}</Text>
        </View>
      </View>
      <View style={styles.transactionRight}>
        <Text
          style={[
            styles.transactionAmount,
            { color: item.type === 'credit' ? theme.brand : theme.ink },
          ]}
        >
          {item.type === 'credit' ? '+' : '-'}
          {formatUSD(item.amount)}
        </Text>
        <Text
          style={[
            styles.transactionStatus,
            {
              color:
                item.status === 'completed'
                  ? theme.up
                  : item.status === 'pending'
                  ? theme.gold
                  : theme.down,
            },
          ]}
        >
          {item.status.charAt(0).toUpperCase() + item.status.slice(1)}
        </Text>
      </View>
    </View>
  );

  return (
    <SafeAreaView edges={['top']} style={styles.container}>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <TouchableOpacity
          style={styles.backButton}
          activeOpacity={0.6}
          onPress={() => { Keyboard.dismiss(); navigation.goBack(); }}
        >
          <Text style={styles.backText}>{'<'}</Text>
        </TouchableOpacity>

        <Text style={styles.title}>Dollar Cards</Text>

        <View style={styles.cardContainer}>
          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <Text style={styles.cardLabel}>VISA</Text>
              {isFrozen && (
                <View style={styles.frozenBadge}>
                  <Text style={styles.frozenText}>FROZEN</Text>
                </View>
              )}
            </View>
            <Text style={styles.cardNumber}>{card.number}</Text>
            <View style={styles.cardDetails}>
              <View>
                <Text style={styles.cardDetailLabel}>CARDHOLDER</Text>
                <Text style={styles.cardDetailValue}>{card.holder}</Text>
              </View>
              <View>
                <Text style={styles.cardDetailLabel}>EXPIRES</Text>
                <Text style={styles.cardDetailValue}>{card.expiry}</Text>
              </View>
            </View>
            <View style={styles.cardBalance}>
              <Text style={styles.balanceLabel}>Balance</Text>
              <Text style={styles.balanceAmount}>{formatUSD(card.balance)}</Text>
            </View>
          </View>
        </View>

        <View style={styles.quickActions}>
          <TouchableOpacity
            style={styles.quickAction}
            activeOpacity={0.7}
            onPress={handleFundCard}
          >
            <View style={[styles.quickActionIcon, { backgroundColor: theme.brandSoft }]}>
              <Text style={[styles.quickActionIconText, { color: theme.brand }]}>$</Text>
            </View>
            <Text style={styles.quickActionLabel}>Fund Card</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.quickAction}
            activeOpacity={0.7}
            onPress={handleFreezeCard}
          >
            <View
              style={[
                styles.quickActionIcon,
                { backgroundColor: isFrozen ? theme.brandSoft : theme.surfaceRaised },
              ]}
            >
              <Text
                style={[
                  styles.quickActionIconText,
                  { color: isFrozen ? theme.brand : theme.ink },
                ]}
              >
                {isFrozen ? '>' : '|'}
              </Text>
            </View>
            <Text style={styles.quickActionLabel}>
              {isFrozen ? 'Unfreeze' : 'Freeze'}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.quickAction}
            activeOpacity={0.7}
            onPress={handleCardDetails}
          >
            <View style={[styles.quickActionIcon, { backgroundColor: theme.surfaceRaised }]}>
              <Text style={[styles.quickActionIconText, { color: theme.ink }]}>i</Text>
            </View>
            <Text style={styles.quickActionLabel}>Details</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.quickAction}
            activeOpacity={0.7}
            onPress={handleConvertUsdt}
          >
            <View style={[styles.quickActionIcon, { backgroundColor: '#EDE9FE' }]}>
              <Text style={[styles.quickActionIconText, { color: '#7C3AED' }]}>₮</Text>
              <View style={styles.comingSoonBadge}>
                <Text style={styles.comingSoonBadgeText}>Soon</Text>
              </View>
            </View>
            <Text style={styles.quickActionLabel}>USDT</Text>
          </TouchableOpacity>
        </View>

        {showDetails && (
          <View style={styles.detailsContainer}>
            <Text style={styles.detailsTitle}>Card Details</Text>
            <View style={styles.detailsRow}>
              <Text style={styles.detailsLabel}>Card Number</Text>
              <Text style={styles.detailsValue}>{card.number}</Text>
            </View>
            <View style={styles.detailsDivider} />
            <View style={styles.detailsRow}>
              <Text style={styles.detailsLabel}>Cardholder</Text>
              <Text style={styles.detailsValue}>{card.holder}</Text>
            </View>
            <View style={styles.detailsDivider} />
            <View style={styles.detailsRow}>
              <Text style={styles.detailsLabel}>Expiry Date</Text>
              <Text style={styles.detailsValue}>{card.expiry}</Text>
            </View>
            <View style={styles.detailsDivider} />
            <View style={styles.detailsRow}>
              <Text style={styles.detailsLabel}>Status</Text>
              <Text
                style={[
                  styles.detailsValue,
                  { color: isFrozen ? theme.gold : theme.brand },
                ]}
              >
                {isFrozen ? 'Frozen' : 'Active'}
              </Text>
            </View>
          </View>
        )}

        <TouchableOpacity
          style={styles.createButton}
          activeOpacity={0.8}
          onPress={handleCreateCard}
        >
          <Text style={styles.createButtonText}>Create New Card</Text>
        </TouchableOpacity>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Recent Transactions</Text>

          {isLoading ? (
            <View style={styles.emptyContainer}>
              <ActivityIndicator color={theme.brand} size="small" />
            </View>
          ) : transactions.length === 0 ? (
            <View style={styles.emptyContainer}>
              <View style={styles.emptyIconContainer}>
                <Text style={styles.emptyIcon}>$</Text>
              </View>
              <Text style={styles.emptyTitle}>No transactions yet</Text>
              <Text style={styles.emptySubtitle}>
                Fund your card to start making international transactions
              </Text>
            </View>
          ) : (
            <View style={styles.transactionList}>
              {transactions.map((item) => (
                <React.Fragment key={item.id}>{renderTransaction({ item })}</React.Fragment>
              ))}
            </View>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.background,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: Spacing.SCREEN_PADDING,
    paddingTop: Spacing.M,
    paddingBottom: 120,
  },
  backButton: {
    width: 48,
    height: 48,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: Spacing.XL,
  },
  backText: {
    fontSize: 28,
    fontWeight: '600',
    color: theme.ink,
  },
  title: {
    ...Typography.SCREEN_TITLE,
    color: theme.ink,
    marginBottom: Spacing.XL,
  },
  cardContainer: {
    marginBottom: Spacing.XL,
  },
  // Deliberately a fixed dark card mockup (like a real bank card) in both
  // themes, not theme-reactive — same reasoning as the receipt/PDF-matching
  // surfaces elsewhere: it's a physical-card visual, not a neutral app surface.
  card: {
    backgroundColor: '#0F1A14',
    borderRadius: Spacing.CARD_RADIUS,
    padding: Spacing.CARD_PADDING,
    minHeight: 200,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: Spacing.XL,
  },
  cardLabel: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 18,
    fontWeight: '700',
    color: '#FFFFFF',
    letterSpacing: 2,
  },
  frozenBadge: {
    backgroundColor: theme.gold,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
  },
  frozenText: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 10,
    fontWeight: '700',
    color: '#FFFFFF',
    letterSpacing: 1,
  },
  cardNumber: {
    fontFamily: 'Helvetica-Mono',
    fontSize: 20,
    lineHeight: 26,
    color: '#FFFFFF',
    letterSpacing: 2,
    marginBottom: Spacing.XL,
  },
  cardDetails: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: Spacing.XL,
  },
  cardDetailLabel: {
    fontFamily: 'Helvetica',
    fontSize: 9,
    color: 'rgba(255,255,255,0.8)',
    letterSpacing: 1,
    marginBottom: Spacing.XS,
  },
  cardDetailValue: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 13,
    color: '#FFFFFF',
  },
  cardBalance: {
    borderTopWidth: 1,
    borderTopColor: 'rgba(255, 255, 255, 0.15)',
    paddingTop: Spacing.M,
  },
  balanceLabel: {
    fontFamily: 'Helvetica',
    fontSize: 11,
    color: 'rgba(255,255,255,0.8)',
    marginBottom: Spacing.XS,
  },
  balanceAmount: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 24,
    lineHeight: 30,
    color: '#FFFFFF',
  },
  quickActions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: Spacing.XL,
  },
  quickAction: {
    flex: 1,
    alignItems: 'center',
    marginHorizontal: Spacing.S,
  },
  quickActionIcon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: Spacing.M,
  },
  quickActionIconText: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 22,
    fontWeight: '600',
  },
  comingSoonBadge: {
    position: 'absolute',
    top: -6,
    right: -10,
    backgroundColor: theme.gold,
    borderRadius: 8,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  comingSoonBadgeText: {
    fontSize: 8,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  quickActionLabel: {
    ...Typography.CAPTION,
    color: theme.ink,
    textAlign: 'center',
  },
  detailsContainer: {
    backgroundColor: theme.surfaceRaised,
    borderRadius: Spacing.CARD_RADIUS,
    padding: Spacing.CARD_PADDING,
    marginBottom: Spacing.XL,
  },
  detailsTitle: {
    ...Typography.SECTION_HEADING,
    color: theme.ink,
    marginBottom: Spacing.L,
  },
  detailsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: Spacing.S,
  },
  detailsLabel: {
    ...Typography.BODY,
    color: theme.inkMuted,
  },
  detailsValue: {
    ...Typography.CARD_TITLE,
    color: theme.ink,
  },
  detailsDivider: {
    height: 1,
    backgroundColor: theme.border,
    marginVertical: Spacing.XS,
  },
  createButton: {
    height: Spacing.BUTTON_HEIGHT_PRIMARY,
    backgroundColor: theme.brand,
    borderRadius: Spacing.BUTTON_RADIUS,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: Spacing.XL,
  },
  createButtonText: {
    ...Typography.BUTTON_TEXT,
  },
  section: {
    marginBottom: Spacing.XL,
  },
  sectionTitle: {
    ...Typography.SECTION_HEADING,
    color: theme.ink,
    marginBottom: Spacing.L,
  },
  emptyContainer: {
    alignItems: 'center',
    paddingVertical: Spacing.XL,
  },
  emptyIconContainer: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: theme.surfaceRaised,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: Spacing.L,
  },
  emptyIcon: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 28,
    color: theme.inkMuted,
  },
  emptyTitle: {
    ...Typography.CARD_TITLE,
    color: theme.ink,
    marginBottom: Spacing.S,
  },
  emptySubtitle: {
    ...Typography.CAPTION,
    color: theme.inkMuted,
    textAlign: 'center',
    paddingHorizontal: Spacing.XL,
  },
  transactionList: {
    backgroundColor: theme.surfaceRaised,
    borderRadius: Spacing.CARD_RADIUS,
    overflow: 'hidden',
  },
  transactionItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: Spacing.CARD_PADDING,
    paddingVertical: Spacing.L,
    borderBottomWidth: 1,
    borderBottomColor: theme.border,
  },
  transactionLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  transactionIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: Spacing.M,
  },
  transactionIconText: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 18,
    fontWeight: '600',
  },
  transactionInfo: {
    flex: 1,
  },
  transactionDescription: {
    ...Typography.CARD_TITLE,
    color: theme.ink,
    marginBottom: Spacing.XS,
  },
  transactionDate: {
    ...Typography.CAPTION,
    color: theme.inkMuted,
  },
  transactionRight: {
    alignItems: 'flex-end',
  },
  transactionAmount: {
    ...Typography.CARD_TITLE,
    marginBottom: Spacing.XS,
  },
  transactionStatus: {
    ...Typography.CAPTION,
    fontWeight: '500',
  },
  });
}
