import React, { useCallback, useState } from 'react';
import {
  View,
  Text,
  Modal,
  StyleSheet,
  TextInput,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  Linking,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AppTheme } from '../constants/theme';
import { useTheme } from './ThemeProvider';
import { Spacing } from '../constants/spacing';
import { Typography } from '../constants/typography';
import { formatNigerianPhone } from '../utils/detectNetwork';
import { NETWORK_LABEL, NETWORK_COLOR } from '../utils/phone';
import { NETWORK_LOGOS } from '../utils/providerLogos';
import { useContacts } from '../hooks/useContacts';
import { PickedContact } from '../services/contacts.service';
import ProviderLogo from './ProviderLogo';

interface Props {
  visible: boolean;
  onClose: () => void;
  onSelect?: (contact: PickedContact) => void;
  /** When true, lets the user check off several contacts before confirming. */
  multiSelect?: boolean;
  onSelectMultiple?: (contacts: PickedContact[]) => void;
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '#';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export default function ContactPickerModal({
  visible,
  onClose,
  onSelect,
  multiSelect = false,
  onSelectMultiple,
}: Props) {
  const { theme } = useTheme();
  const styles = createStyles(theme);
  const { contacts, loading, permission, query, setQuery } = useContacts();
  // Store the FULL selected contact objects (not just ids), keyed by id, so a
  // selection survives even after the search query changes and filters that
  // contact out of the visible `contacts` list. Filtering the visible list at
  // "Done" time was dropping everything picked under an earlier search.
  const [selected, setSelected] = useState<Map<string, PickedContact>>(new Map());

  const handleClose = useCallback(() => {
    setSelected(new Map());
    onClose();
  }, [onClose]);

  const toggleSelect = useCallback((item: PickedContact) => {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(item.id)) next.delete(item.id);
      else next.set(item.id, item);
      return next;
    });
  }, []);

  const handleDone = useCallback(() => {
    const chosen = Array.from(selected.values());
    setSelected(new Map());
    onSelectMultiple?.(chosen);
  }, [selected, onSelectMultiple]);

  const renderItem = ({ item }: { item: PickedContact }) => {
    const isChecked = selected.has(item.id);
    return (
      <TouchableOpacity
        style={styles.row}
        activeOpacity={0.6}
        onPress={() => (multiSelect ? toggleSelect(item) : onSelect?.(item))}
      >
        {multiSelect && (
          <View style={[styles.checkbox, isChecked && styles.checkboxChecked]}>
            {isChecked && <Text style={styles.checkboxTick}>✓</Text>}
          </View>
        )}
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{initialsOf(item.name)}</Text>
        </View>
        <View style={styles.rowMid}>
          <Text style={styles.name} numberOfLines={1}>
            {item.name}
          </Text>
          <Text style={styles.number}>{formatNigerianPhone(item.phone)}</Text>
        </View>
        <ProviderLogo
          source={NETWORK_LOGOS[item.network]}
          fallbackLabel={NETWORK_LABEL[item.network]}
          fallbackColor={NETWORK_COLOR[item.network]}
          size={36}
        />
      </TouchableOpacity>
    );
  };

  const renderBody = () => {
    if (loading) {
      return (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={theme.brand} />
          <Text style={styles.muted}>Loading contacts…</Text>
        </View>
      );
    }
    if (permission === 'denied') {
      return (
        <View style={styles.center}>
          <Text style={styles.emptyIcon}>📇</Text>
          <Text style={styles.emptyTitle}>Contacts access needed</Text>
          <Text style={styles.muted}>
            Allow access to pick a saved number instead of typing it.
          </Text>
          <TouchableOpacity style={styles.settingsBtn} onPress={() => Linking.openSettings()}>
            <Text style={styles.settingsBtnText}>Open Settings</Text>
          </TouchableOpacity>
        </View>
      );
    }
    if (contacts.length === 0) {
      return (
        <View style={styles.center}>
          <Text style={styles.emptyIcon}>🔍</Text>
          <Text style={styles.muted}>
            {query ? 'No matching contacts' : 'No saved Nigerian numbers found'}
          </Text>
        </View>
      );
    }
    return (
      <FlatList
        data={contacts}
        keyExtractor={(c) => c.id}
        renderItem={renderItem}
        keyboardShouldPersistTaps="handled"
        initialNumToRender={15}
        windowSize={10}
        ItemSeparatorComponent={() => <View style={styles.sep} />}
      />
    );
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={handleClose}>
      <SafeAreaView style={styles.container}>
        <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <View style={styles.header}>
          <Text style={styles.title}>{multiSelect ? 'Select Contacts' : 'Choose Contact'}</Text>
          <TouchableOpacity onPress={handleClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Text style={styles.close}>✕</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.searchWrap}>
          <Text style={styles.searchIcon}>🔍</Text>
          <TextInput
            style={styles.search}
            placeholder="Search name or number"
            placeholderTextColor={theme.inkFaint}
            value={query}
            onChangeText={setQuery}
            autoCorrect={false}
            autoCapitalize="none"
          />
        </View>

          {renderBody()}

          {multiSelect && (
            <View style={styles.footer}>
            <TouchableOpacity
              style={[styles.doneBtn, selected.size === 0 && styles.doneBtnDisabled]}
              onPress={handleDone}
              disabled={selected.size === 0}
              activeOpacity={0.8}
            >
              <Text style={styles.doneBtnText}>
                Done{selected.size > 0 ? ` (${selected.size} selected)` : ''}
              </Text>
            </TouchableOpacity>
            </View>
          )}
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.L,
    paddingVertical: Spacing.M,
    borderBottomWidth: 1,
    borderBottomColor: theme.border,
  },
  title: { ...Typography.SCREEN_TITLE, color: theme.ink },
  close: { fontSize: 22, color: theme.ink, paddingHorizontal: Spacing.S },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    margin: Spacing.L,
    paddingHorizontal: Spacing.L,
    height: Spacing.INPUT_HEIGHT,
    backgroundColor: theme.surfaceRaised,
    borderRadius: Spacing.BUTTON_RADIUS,
  },
  searchIcon: { fontSize: 16, marginRight: Spacing.M },
  search: { flex: 1, ...Typography.BODY, color: theme.ink, paddingVertical: 0 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.L,
    paddingVertical: Spacing.M,
    minHeight: Spacing.TOUCH_TARGET_MIN + 8,
  },
  avatar: {
    width: Spacing.AVATAR_MEDIUM,
    height: Spacing.AVATAR_MEDIUM,
    borderRadius: Spacing.AVATAR_MEDIUM / 2,
    backgroundColor: theme.brandSoft,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: Spacing.M,
  },
  avatarText: { ...Typography.CAPTION, color: theme.brand, fontWeight: '700' },
  rowMid: { flex: 1, marginRight: Spacing.M },
  name: { ...Typography.BODY, color: theme.ink },
  number: { ...Typography.CAPTION, color: theme.inkMuted, marginTop: 2 },
  badge: {
    paddingHorizontal: Spacing.M,
    height: Spacing.CHIP_HEIGHT,
    borderRadius: Spacing.CHIP_HEIGHT / 2,
    justifyContent: 'center',
    alignItems: 'center',
  },
  badgeText: { ...Typography.CAPTION, color: '#FFFFFF', fontWeight: '700' },
  sep: { height: 1, backgroundColor: theme.border, marginLeft: Spacing.L + Spacing.AVATAR_MEDIUM + Spacing.M },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: Spacing.XL },
  muted: { ...Typography.BODY, color: theme.inkMuted, textAlign: 'center', marginTop: Spacing.M },
  emptyIcon: { fontSize: 44, marginBottom: Spacing.S },
  emptyTitle: { ...Typography.HEADING, color: theme.ink, marginBottom: Spacing.S },
  settingsBtn: {
    marginTop: Spacing.L,
    backgroundColor: theme.brand,
    height: Spacing.BUTTON_HEIGHT_SECONDARY,
    paddingHorizontal: Spacing.XL,
    borderRadius: Spacing.BUTTON_RADIUS,
    justifyContent: 'center',
    alignItems: 'center',
  },
  settingsBtnText: { ...Typography.BUTTON_TEXT, color: '#FFFFFF' },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: theme.border,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: Spacing.M,
  },
  checkboxChecked: {
    borderColor: theme.brand,
    backgroundColor: theme.brand,
  },
  checkboxTick: { color: '#FFFFFF', fontSize: 13, fontWeight: '700' },
  footer: {
    padding: Spacing.L,
    borderTopWidth: 1,
    borderTopColor: theme.border,
  },
  doneBtn: {
    height: Spacing.BUTTON_HEIGHT_PRIMARY,
    backgroundColor: theme.brand,
    borderRadius: Spacing.BUTTON_RADIUS,
    justifyContent: 'center',
    alignItems: 'center',
  },
  doneBtnDisabled: {
    backgroundColor: theme.inkFaint,
    opacity: 0.6,
  },
  doneBtnText: { ...Typography.BUTTON_TEXT, color: '#FFFFFF' },
  });
}
