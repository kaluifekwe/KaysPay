import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  FlatList,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Colors } from '../constants/colors';
import { Typography } from '../constants/typography';
import { Spacing } from '../constants/spacing';
import { paystackService, Bank } from '../services/paystack.service';

interface BankListScreenProps {
  navigation: any;
  route: {
    params?: {
      onSelect?: (bank: Bank) => void;
    };
  };
}

export default function BankListScreen({ navigation, route }: BankListScreenProps) {
  const [banks, setBanks] = useState<Bank[]>([]);
  const [filteredBanks, setFilteredBanks] = useState<Bank[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadBanks();
  }, []);

  useEffect(() => {
    if (search.trim() === '') {
      setFilteredBanks(banks);
    } else {
      const query = search.toLowerCase();
      setFilteredBanks(
        banks.filter(
          (bank) =>
            bank.name.toLowerCase().includes(query) ||
            bank.code.includes(query)
        )
      );
    }
  }, [search, banks]);

  const loadBanks = async () => {
    setLoading(true);
    setError(null);

    const result = await paystackService.listBanks();

    if (!result.success || !result.banks) {
      setError(result.error || 'Failed to load banks');
      setLoading(false);
      return;
    }

    setBanks(result.banks);
    setFilteredBanks(result.banks);
    setLoading(false);
  };

  const handleSelectBank = (bank: Bank) => {
    navigation.goBack();
    // The parent screen handles the selection via route callback
    // We pass the bank back through navigation params
    navigation.navigate({
      name: 'Withdraw',
      params: { selectedBank: bank },
      merge: true,
    });
  };

  const renderBank = ({ item }: { item: Bank }) => (
    <TouchableOpacity
      style={styles.bankItem}
      onPress={() => handleSelectBank(item)}
      activeOpacity={0.7}
    >
      <View style={styles.bankIcon}>
        <Text style={styles.bankIconText}>🏦</Text>
      </View>
      <View style={styles.bankInfo}>
        <Text style={styles.bankName}>{item.name}</Text>
        <Text style={styles.bankCode}>Code: {item.code}</Text>
      </View>
    </TouchableOpacity>
  );

  if (loading) {
    return (
      <SafeAreaView edges={['top']} style={styles.safeArea}>
        <View style={styles.header}>
          <TouchableOpacity
            style={styles.backButton}
            onPress={() => navigation.goBack()}
          >
            <Text style={styles.backText}>{'<'}</Text>
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Select Bank</Text>
          <View style={styles.headerRight} />
        </View>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={Colors.GREEN} />
          <Text style={styles.loadingText}>Loading banks...</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (error) {
    return (
      <SafeAreaView edges={['top']} style={styles.safeArea}>
        <View style={styles.header}>
          <TouchableOpacity
            style={styles.backButton}
            onPress={() => navigation.goBack()}
          >
            <Text style={styles.backText}>{'<'}</Text>
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Select Bank</Text>
          <View style={styles.headerRight} />
        </View>
        <View style={styles.errorContainer}>
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity style={styles.retryButton} onPress={loadBanks}>
            <Text style={styles.retryButtonText}>Retry</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView edges={['top']} style={styles.safeArea}>
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => navigation.goBack()}
        >
          <Text style={styles.backText}>{'<'}</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Select Bank</Text>
        <View style={styles.headerRight} />
      </View>

      <View style={styles.searchContainer}>
        <Text style={styles.searchIcon}>🔍</Text>
        <TextInput
          style={styles.searchInput}
          value={search}
          onChangeText={setSearch}
          placeholder="Search banks..."
          placeholderTextColor={Colors.GRAY}
          autoCapitalize="none"
          autoCorrect={false}
        />
        {search.length > 0 && (
          <TouchableOpacity onPress={() => setSearch('')}>
            <Text style={styles.clearSearch}>✕</Text>
          </TouchableOpacity>
        )}
      </View>

      <Text style={styles.resultCount}>
        {filteredBanks.length} bank{filteredBanks.length !== 1 ? 's' : ''} found
      </Text>

      <FlatList
        data={filteredBanks}
        renderItem={renderBank}
        keyExtractor={(item) => item.code}
        contentContainerStyle={styles.listContent}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyText}>No banks found</Text>
          </View>
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: Colors.WHITE,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.SCREEN_PADDING,
    paddingTop: Spacing.S,
    paddingBottom: Spacing.XS,
    borderBottomWidth: 1,
    borderBottomColor: Colors.BORDER,
  },
  backButton: {
    width: 48,
    height: 48,
    justifyContent: 'center',
    alignItems: 'center',
  },
  backText: {
    fontSize: 28,
    fontWeight: '600',
    color: Colors.DARK,
  },
  headerTitle: {
    ...Typography.BODY,
    fontWeight: '600',
    flex: 1,
    textAlign: 'center',
  },
  headerRight: {
    width: 48,
  },
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: Spacing.SCREEN_PADDING,
    marginTop: Spacing.M,
    marginBottom: Spacing.S,
    borderWidth: Spacing.INPUT_BORDER_WIDTH,
    borderColor: Colors.BORDER,
    borderRadius: Spacing.BUTTON_RADIUS,
    height: Spacing.INPUT_HEIGHT,
    paddingHorizontal: Spacing.M,
    backgroundColor: Colors.LIGHT_GRAY,
  },
  searchIcon: {
    fontSize: 16,
    marginRight: Spacing.S,
  },
  searchInput: {
    flex: 1,
    ...Typography.BODY,
    color: Colors.DARK,
    height: '100%',
  },
  clearSearch: {
    fontSize: 18,
    color: Colors.GRAY,
    padding: Spacing.S,
  },
  resultCount: {
    ...Typography.CAPTION,
    color: Colors.GRAY,
    marginHorizontal: Spacing.SCREEN_PADDING,
    marginBottom: Spacing.S,
  },
  listContent: {
    paddingHorizontal: Spacing.SCREEN_PADDING,
  },
  bankItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: Spacing.M,
  },
  bankIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: Colors.GREEN_LIGHT,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: Spacing.M,
  },
  bankIconText: {
    fontSize: 20,
  },
  bankInfo: {
    flex: 1,
  },
  bankName: {
    ...Typography.BODY,
    fontWeight: '500',
    color: Colors.DARK,
  },
  bankCode: {
    ...Typography.CAPTION,
    color: Colors.GRAY,
    marginTop: 2,
  },
  separator: {
    height: 1,
    backgroundColor: Colors.BORDER,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    ...Typography.BODY,
    marginTop: Spacing.M,
    color: Colors.GRAY,
  },
  errorContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: Spacing.XL,
  },
  errorText: {
    ...Typography.BODY,
    textAlign: 'center',
    color: Colors.RED,
    marginBottom: Spacing.L,
  },
  retryButton: {
    backgroundColor: Colors.GREEN,
    height: Spacing.BUTTON_HEIGHT_PRIMARY,
    borderRadius: Spacing.BUTTON_RADIUS,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: Spacing.XL,
  },
  retryButtonText: {
    ...Typography.BUTTON_TEXT,
    color: Colors.WHITE,
  },
  emptyContainer: {
    paddingVertical: Spacing.XL,
    alignItems: 'center',
  },
  emptyText: {
    ...Typography.BODY,
    color: Colors.GRAY,
  },
});
