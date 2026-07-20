import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  StatusBar,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { Colors } from '../constants/colors';
import { Typography } from '../constants/typography';
import { Spacing } from '../constants/spacing';
import { walletService } from '../services/wallet.service';
import { formatNaira } from '../utils/formatCurrency';
import { Transaction } from '../types/app.types';
import { useCachedData } from '../hooks/useCachedData';
import TransactionDetailModal, { TransactionDetailItem } from '../components/TransactionDetailModal';

type TransactionItem = TransactionDetailItem;

interface DateGroup {
  title: string;
  data: TransactionItem[];
}

const TRANSACTION_LABELS: Record<string, string> = {
  wallet_fund: 'Wallet Funding',
  refund: 'Refund',
  airtime: 'Airtime',
  data: 'Data Bundle',
  bill: 'Bill Payment',
  exam_pin: 'Exam Pin',
  foreign_number: 'Foreign Number',
  card_fund: 'Card Funding',
  withdrawal: 'Withdrawal',
  esim: 'eSIM',
  nin_verification: 'NIN Verification',
  nin_validation: 'NIN Validation',
  bvn_verification: 'BVN Verification',
  nin_name_modification: 'NIN Name Update',
  nin_phone_modification: 'NIN Phone Update',
  nin_address_modification: 'NIN Address Update',
};

const getTransactionIcon = (direction: 'credit' | 'debit') => {
  return direction === 'credit' ? '↓' : '↑';
};

const getStatusColor = (status: string) => {
  switch (status) {
    case 'successful':
      return Colors.SUCCESS;
    case 'pending':
      return Colors.AMBER;
    case 'failed':
      return Colors.ERROR;
    default:
      return Colors.GRAY;
  }
};

const groupTransactionsByDate = (transactions: TransactionItem[]): DateGroup[] => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  const thisWeekStart = new Date(today);
  thisWeekStart.setDate(thisWeekStart.getDate() - today.getDay());

  const groups: { [key: string]: TransactionItem[] } = {
    'Today': [],
    'Yesterday': [],
    'This Week': [],
    'Earlier': [],
  };

  transactions.forEach((transaction) => {
    const transactionDate = new Date(transaction.timestamp);
    transactionDate.setHours(0, 0, 0, 0);

    if (transactionDate.getTime() === today.getTime()) {
      groups['Today'].push(transaction);
    } else if (transactionDate.getTime() === yesterday.getTime()) {
      groups['Yesterday'].push(transaction);
    } else if (transactionDate >= thisWeekStart) {
      groups['This Week'].push(transaction);
    } else {
      groups['Earlier'].push(transaction);
    }
  });

  return Object.entries(groups)
    .filter(([, data]) => data.length > 0)
    .map(([title, data]) => ({ title, data }));
};

const formatTimestamp = (timestamp: string): string => {
  const date = new Date(timestamp);
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const ampm = hours >= 12 ? 'PM' : 'AM';
  const formattedHours = hours % 12 || 12;
  const formattedMinutes = minutes.toString().padStart(2, '0');
  return `${formattedHours}:${formattedMinutes} ${ampm}`;
};

const TransactionHistoryScreen: React.FC = () => {
  const navigation = useNavigation();
  const [refreshing, setRefreshing] = useState(false);

  // Shows the last-known transaction list immediately (even on a bad
  // connection) while refreshing in the background, instead of a blank
  // "Loading transactions..." screen every single time this opens.
  const fetchTransactionsOrThrow = useCallback(async (): Promise<TransactionItem[]> => {
    const response = await walletService.getRecentTransactions(50);
    if (!response.success || !response.transactions) {
      throw new Error('Failed to load transactions');
    }
    return response.transactions.map((txn: Transaction) => ({
      id: txn.id,
      direction: (txn.type === 'wallet_fund' || txn.type === 'refund') ? 'credit' : 'debit',
      rawType: txn.type,
      label: TRANSACTION_LABELS[txn.type] || txn.type,
      recipientPhone: txn.recipient_phone || undefined,
      network: txn.network || undefined,
      amount: txn.amount_ngn,
      status: txn.status === 'completed' ? 'successful' : txn.status,
      timestamp: txn.created_at,
      orderId: txn.vtu_order_id,
      metadata: txn.metadata,
    }));
  }, []);

  const {
    data: transactionsData,
    loading,
    isStale,
    error,
    refresh: fetchTransactions,
  } = useCachedData<TransactionItem[]>('transaction_history', fetchTransactionsOrThrow);
  const transactions = transactionsData ?? [];

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchTransactions();
    setRefreshing(false);
  }, [fetchTransactions]);

  const [selectedTransaction, setSelectedTransaction] = useState<TransactionItem | null>(null);

  const renderDateGroup = ({ item }: { item: DateGroup }) => (
    <View style={styles.dateGroup}>
      <Text style={styles.dateGroupTitle}>{item.title}</Text>
      {item.data.map((transaction) => (
        <TransactionItemComponent key={transaction.id} item={transaction} onPress={() => setSelectedTransaction(transaction)} />
      ))}
    </View>
  );

  const TransactionItemComponent = ({ item, onPress }: { item: TransactionItem; onPress: () => void }) => (
    <TouchableOpacity style={styles.transactionItem} onPress={onPress} activeOpacity={0.7}>
      <View
        style={[
          styles.iconContainer,
          { backgroundColor: item.direction === 'credit' ? Colors.GREEN_LIGHT : Colors.LIGHT_GRAY },
        ]}
      >
        <Text
          style={[
            styles.icon,
            { color: item.direction === 'credit' ? Colors.GREEN : Colors.DARK },
          ]}
        >
          {getTransactionIcon(item.direction)}
        </Text>
      </View>

      <View style={styles.transactionDetails}>
        <Text style={styles.transactionType}>{item.label}</Text>
        {item.recipientPhone && (
          <Text style={styles.recipientPhone}>{item.recipientPhone}</Text>
        )}
      </View>

      <View style={styles.amountContainer}>
        <Text
          style={[
            styles.amount,
            { color: item.direction === 'credit' ? Colors.GREEN : Colors.RED },
          ]}
        >
          {item.direction === 'credit' ? '+' : '-'}{formatNaira(item.amount)}
        </Text>
        <Text style={styles.timestamp}>{formatTimestamp(item.timestamp)}</Text>
      </View>

      <View
        style={[
          styles.statusBadge,
          { backgroundColor: getStatusColor(item.status) + '20' },
        ]}
      >
        <Text
          style={[styles.statusText, { color: getStatusColor(item.status) }]}
        >
          {item.status.charAt(0).toUpperCase() + item.status.slice(1)}
        </Text>
      </View>
    </TouchableOpacity>
  );

  const renderEmptyState = () => (
    <View style={styles.emptyState}>
      <Text style={styles.emptyStateIcon}>📋</Text>
      <Text style={styles.emptyStateTitle}>No Transactions Yet</Text>
      <Text style={styles.emptyStateText}>
        Your transaction history will appear here once you start using the app.
      </Text>
    </View>
  );

  const renderErrorState = () => (
    <View style={styles.emptyState}>
      <Text style={styles.emptyStateIcon}>⚠️</Text>
      <Text style={styles.emptyStateTitle}>Error Loading Transactions</Text>
      <Text style={styles.emptyStateText}>{error}</Text>
      <TouchableOpacity style={styles.retryButton} onPress={fetchTransactions}>
        <Text style={styles.retryButtonText}>Retry</Text>
      </TouchableOpacity>
    </View>
  );

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <StatusBar barStyle="dark-content" backgroundColor={Colors.WHITE} />
        <View style={styles.header}>
          <TouchableOpacity
            style={styles.backButton}
            onPress={() => navigation.goBack()}
          >
            <Text style={styles.backButtonText}>{'<'}</Text>
          </TouchableOpacity>
          <Text style={styles.title}>Transaction History</Text>
        </View>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={Colors.GREEN} />
          <Text style={styles.loadingText}>Loading transactions...</Text>
        </View>
      </SafeAreaView>
    );
  }

  const groupedTransactions = groupTransactionsByDate(transactions);

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor={Colors.WHITE} />

      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => navigation.goBack()}
        >
          <Text style={styles.backButtonText}>{'<'}</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Transaction History</Text>
      </View>

      {isStale && !loading && (
        <View style={styles.staleBanner}>
          <Text style={styles.staleBannerText}>Showing saved data — pull down to refresh</Text>
        </View>
      )}

      {error ? (
        renderErrorState()
      ) : transactions.length === 0 ? (
        renderEmptyState()
      ) : (
        <FlatList
          data={groupedTransactions}
          renderItem={renderDateGroup}
          keyExtractor={(item) => item.title}
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              colors={[Colors.GREEN]}
              tintColor={Colors.GREEN}
            />
          }
          showsVerticalScrollIndicator={false}
        />
      )}

      <TransactionDetailModal
        visible={selectedTransaction !== null}
        transaction={selectedTransaction}
        onClose={() => setSelectedTransaction(null)}
      />
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.WHITE,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.SCREEN_PADDING,
    paddingVertical: Spacing.M,
    borderBottomWidth: 1,
    borderBottomColor: Colors.BORDER,
  },
  staleBanner: {
    backgroundColor: Colors.LIGHT_GRAY,
    paddingVertical: Spacing.S,
    alignItems: 'center',
  },
  staleBannerText: {
    ...Typography.CAPTION,
    color: Colors.GRAY,
  },
  backButton: {
    width: 48,
    height: 48,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: Spacing.S,
  },
  backButtonText: {
    fontSize: 28,
    fontWeight: '600',
    color: Colors.DARK,
  },
  title: {
    ...Typography.SCREEN_TITLE,
    color: Colors.DARK,
  },
  listContent: {
    paddingBottom: Spacing.XL,
  },
  dateGroup: {
    marginBottom: Spacing.M,
  },
  dateGroupTitle: {
    ...Typography.SECTION_HEADING,
    color: Colors.GRAY,
    paddingHorizontal: Spacing.SCREEN_PADDING,
    paddingTop: Spacing.L,
    paddingBottom: Spacing.S,
  },
  transactionItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.SCREEN_PADDING,
    paddingVertical: Spacing.M,
    borderBottomWidth: 1,
    borderBottomColor: Colors.BORDER,
  },
  iconContainer: {
    width: 40,
    height: 40,
    borderRadius: 20,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: Spacing.M,
  },
  icon: {
    fontSize: 20,
    fontWeight: '600',
  },
  transactionDetails: {
    flex: 1,
  },
  transactionType: {
    ...Typography.CARD_TITLE,
    color: Colors.DARK,
    marginBottom: 2,
  },
  recipientPhone: {
    ...Typography.CAPTION,
    color: Colors.GRAY,
  },
  amountContainer: {
    alignItems: 'flex-end',
    marginRight: Spacing.M,
  },
  amount: {
    ...Typography.AMOUNT_SMALL,
    marginBottom: 2,
  },
  timestamp: {
    ...Typography.CAPTION,
    color: Colors.GRAY,
  },
  statusBadge: {
    paddingHorizontal: Spacing.S,
    paddingVertical: Spacing.XS,
    borderRadius: Spacing.BUTTON_RADIUS,
    minWidth: 70,
    alignItems: 'center',
  },
  statusText: {
    ...Typography.CAPTION,
    fontWeight: '600',
  },
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: Spacing.XL,
  },
  emptyStateIcon: {
    fontSize: 64,
    marginBottom: Spacing.M,
  },
  emptyStateTitle: {
    ...Typography.SCREEN_TITLE,
    color: Colors.DARK,
    marginBottom: Spacing.S,
  },
  emptyStateText: {
    ...Typography.BODY,
    color: Colors.GRAY,
    textAlign: 'center',
    lineHeight: 24,
  },
  retryButton: {
    marginTop: Spacing.L,
    backgroundColor: Colors.GREEN,
    paddingHorizontal: Spacing.XL,
    paddingVertical: Spacing.M,
    borderRadius: Spacing.BUTTON_RADIUS,
  },
  retryButtonText: {
    ...Typography.BUTTON_TEXT,
    color: Colors.WHITE,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    ...Typography.BODY,
    color: Colors.GRAY,
    marginTop: Spacing.M,
  },
});

export default TransactionHistoryScreen;
