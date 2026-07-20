import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  ScrollView,
  TouchableOpacity,
  TextInput,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { kycService } from '../services/kyc.service';

const BRAND_GREEN = '#1A5C3A';
const DARK_TEXT = '#0F1A14';
const GRAY_TEXT = '#6B7280';
const WHITE = '#FFFFFF';
const BORDER_COLOR = '#E5E7EB';

// Email and phone are fixed at signup and never editable again (owner
// decision, 2026-07-06) — this screen only ever touches name and address.
export default function EditProfileScreen({ navigation }: any) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');

  const [fullName, setFullName] = useState('');
  const [address, setAddress] = useState('');
  const [nameLocked, setNameLocked] = useState(false);

  useFocusEffect(
    useCallback(() => {
      loadUser();
    }, []),
  );

  const loadUser = async () => {
    setLoading(true);
    try {
      const [{ data: { user } }, kyc] = await Promise.all([
        supabase.auth.getUser(),
        kycService.getStatus(),
      ]);
      setEmail(user?.email || '');
      setPhone(user?.phone || user?.user_metadata?.phone || '');
      setFullName(user?.user_metadata?.full_name || '');
      setAddress(user?.user_metadata?.address || '');
      setNameLocked(kyc.verified);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    if (!fullName.trim()) {
      Alert.alert('Full name required', 'Please enter your full name.');
      return;
    }
    setSaving(true);
    try {
      const { error } = await supabase.auth.updateUser({
        data: { full_name: fullName.trim(), address: address.trim() },
      });
      if (error) throw error;
      Alert.alert('Saved', 'Your profile has been updated.');
      navigation.goBack();
    } catch (error: any) {
      Alert.alert('Error', error.message || 'Could not save your changes. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.loadingContainer}>
          <ActivityIndicator color={BRAND_GREEN} size="large" />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => navigation.goBack()}
          activeOpacity={0.7}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Text style={styles.backButtonText}>{'‹'}</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Edit Profile</Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.fieldCard}>
          <Text style={styles.fieldLabel}>Full Name</Text>
          {nameLocked ? (
            <>
              <Text style={styles.fieldValue}>{fullName}</Text>
              <Text style={styles.helperText}>Verified via NIN — locked.</Text>
            </>
          ) : (
            <TextInput
              style={styles.input}
              value={fullName}
              onChangeText={setFullName}
              placeholder="Your full name"
              placeholderTextColor="#9CA3AF"
              autoCapitalize="words"
              autoCorrect={false}
            />
          )}
        </View>

        <View style={styles.fieldCard}>
          <Text style={styles.fieldLabel}>Address</Text>
          <TextInput
            style={[styles.input, styles.multilineInput]}
            value={address}
            onChangeText={setAddress}
            placeholder="e.g. 12 Awolowo Road, Ikeja"
            placeholderTextColor="#9CA3AF"
            multiline
            numberOfLines={2}
          />
        </View>

        <View style={styles.fieldCard}>
          <Text style={styles.fieldLabel}>Email Address</Text>
          <Text style={styles.fieldValue}>{email || 'Not set'}</Text>
          <Text style={styles.helperText}>Fixed at signup and can't be changed.</Text>
        </View>

        <View style={styles.fieldCard}>
          <Text style={styles.fieldLabel}>Phone Number</Text>
          <Text style={styles.fieldValue}>{phone || 'Not set'}</Text>
          <Text style={styles.helperText}>Fixed at signup and can't be changed.</Text>
        </View>

        <TouchableOpacity
          style={[styles.saveButton, saving && styles.saveButtonDisabled]}
          onPress={handleSave}
          disabled={saving}
          activeOpacity={0.8}
        >
          {saving ? (
            <ActivityIndicator color={WHITE} size="small" />
          ) : (
            <Text style={styles.saveButtonText}>Save Changes</Text>
          )}
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: WHITE,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: BORDER_COLOR,
  },
  backButton: {
    width: 44,
    height: 44,
    justifyContent: 'center',
    alignItems: 'center',
  },
  backButtonText: {
    fontSize: 28,
    fontWeight: '600',
    color: DARK_TEXT,
  },
  headerTitle: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 18,
    color: DARK_TEXT,
    flex: 1,
    textAlign: 'center',
  },
  headerSpacer: {
    width: 44,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    padding: 16,
    paddingBottom: 40,
  },
  fieldCard: {
    backgroundColor: WHITE,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: BORDER_COLOR,
    padding: 16,
    marginBottom: 16,
  },
  fieldLabel: {
    fontSize: 12,
    color: GRAY_TEXT,
    fontWeight: '600',
    marginBottom: 8,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  fieldValue: {
    fontSize: 16,
    color: DARK_TEXT,
    fontWeight: '500',
  },
  input: {
    height: 48,
    borderWidth: 1.5,
    borderColor: BORDER_COLOR,
    borderRadius: 10,
    paddingHorizontal: 14,
    fontSize: 15,
    color: DARK_TEXT,
  },
  multilineInput: {
    height: 72,
    paddingTop: 12,
    textAlignVertical: 'top',
  },
  helperText: {
    fontSize: 12,
    color: GRAY_TEXT,
    marginTop: 8,
    lineHeight: 17,
  },
  saveButton: {
    backgroundColor: BRAND_GREEN,
    height: 52,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 8,
  },
  saveButtonDisabled: {
    opacity: 0.7,
  },
  saveButtonText: {
    fontSize: 15,
    color: WHITE,
    fontWeight: '700',
  },
});
