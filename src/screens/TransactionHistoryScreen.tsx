import React, { useState, useEffect, useCallback } from 'react';
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

interface TransactionItem {
  id: string;
  type: 'credit' | 'debit';
  label: string;
  recipientPhone?: string;
  amount: number;
  status: 'successful' | 'pending' | 'failed' | 'refunded';
  timestamp: string;
}

interface DateGroup {
  title: string;
  data: TransactionItem[];
}

const getTransactionIcon = (type: 'credit' | 'debit') => {
  return type === 'credit' ? '↓' : '↑';
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
  const [transactions, setTransactions] = useState<TransactionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchTransactions = useCallback(async () => {
    try {
      setError(null);
      const response = await walletService.getRecentTransactions(50);

      if (response.success && response.transactions) {
        const formattedTransactions: TransactionItem[] = response.transactions.map(
          (txn: Transaction) => ({
            id: txn.id,
            type: (txn.type === 'wallet_fund' || txn.type === 'refund') ? 'credit' : 'debit',
            label: txn.type === 'wallet_fund' ? 'Wallet Funding' : txn.type === 'refund' ? 'Refund' : txn.type,
            recipientPhone: txn.recipient_phone || undefined,
            amount: txn.amount_ngn,
            status: txn.status === 'completed' ? 'successful' : txn.status,
            timestamp: txn.created_at,
          })
        );
        setTransactions(formattedTransactions);
      } else {
        setError('Failed to load transactions');
      }
    } catch (err) {
      setError('An error occurred while loading transactions');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTransactions();
  }, [fetchTransactions]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchTransactions();
    setRefreshing(false);
  }, [fetchTransactions]);

  const renderTransactionItem = ({ item }: { item: TransactionItem }) => (
    <View style={styles.transactionItem}>
      <View
        style={[
          styles.iconContainer,
          { backgroundColor: item.type === 'credit' ? Colors.GREEN_LIGHT : Colors.LIGHT_GRAY },
        ]}
      >
        <Text
          style={[
            styles.icon,
            { color: item.type === 'credit' ? Colors.GREEN : Colors.DARK },
          ]}
        >
          {getTransactionIcon(item.type)}
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
            { color: item.type === 'credit' ? Colors.GREEN : Colors.RED },
          ]}
        >
          {item.type === 'credit' ? '+' : '-'}{formatNaira(item.amount)}
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
    </View>
  );

  const renderDateGroup = ({ item }: { item: DateGroup }) => (
    <View style={styles.dateGroup}>
      <Text style={styles.dateGroupTitle}>{item.title}</Text>
      {item.data.map((transaction) => (
        <TransactionItemComponent key={transaction.id} item={transaction} />
      ))}
    </View>
  );

  const TransactionItemComponent = ({ item }: { item: TransactionItem }) => (
    <View style={styles.transactionItem}>
      <View
        style={[
          styles.iconContainer,
          { backgroundColor: item.type === 'credit' ? Colors.GREEN_LIGHT : Colors.LIGHT_GRAY },
        ]}
      >
        <Text
          style={[
            styles.icon,
            { color: item.type === 'credit' ? Colors.GREEN : Colors.DARK },
          ]}
        >
          {getTransactionIcon(item.type)}
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
            { color: item.type === 'credit' ? Colors.GREEN : Colors.RED },
          ]}
        >
          {item.type === 'credit' ? '+' : '-'}{formatNaira(item.amount)}
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
    </View>
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
