import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
  TouchableOpacity,
  StatusBar,
  Alert,
} from 'react-native';
import { WebView } from 'react-native-webview';
import { Colors } from '../constants/colors';
import { Typography } from '../constants/typography';
import { Spacing } from '../constants/spacing';
import { paystackService } from '../services/paystack.service';

// Sentinel URL Paystack redirects the WebView to after payment. It doesn't need
// to resolve — we intercept the navigation to it and never actually load it.
const PAYSTACK_CALLBACK_URL = 'https://kayspay.app/paystack/callback';

function getQueryParam(url: string, key: string): string | null {
  const m = url.match(new RegExp('[?&]' + key + '=([^&#]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}

export default function PaystackCheckoutScreen(props: any) {
  const { navigation, route } = props;
  const { amount, email } = route.params;
  const [authorizationUrl, setAuthorizationUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const processedRef = useRef(false);
  const referenceRef = useRef<string | null>(null);

  useEffect(() => {
    initPayment();
  }, []);

  const initPayment = async () => {
    try {
      const reference = `KP_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
      referenceRef.current = reference;
      const result = await paystackService.initializeTransaction(
        email,
        amount,
        reference,
        PAYSTACK_CALLBACK_URL,
      );

      if (!result.success || !result.authorization_url) {
        setError(result.error || 'Failed to initialize payment');
        setLoading(false);
        return;
      }

      setAuthorizationUrl(result.authorization_url);
      setLoading(false);
    } catch (err: any) {
      setError(err.message || 'Failed to initialize payment');
      setLoading(false);
    }
  };

  // Called once when the WebView reaches our callback URL after payment.
  const completeFromUrl = (url: string) => {
    if (processedRef.current) return;
    processedRef.current = true;
    setVerifying(true);
    const reference =
      getQueryParam(url, 'reference') ||
      getQueryParam(url, 'trxref') ||
      referenceRef.current;
    if (reference) {
      handlePaymentSuccess(reference);
    } else {
      Alert.alert('Payment', 'Could not read the payment reference. Please contact support.', [
        { text: 'OK', onPress: () => navigation.goBack() },
      ]);
    }
  };

  // Primary detection: intercept navigation to the callback before it loads.
  const handleShouldStartLoad = (request: any): boolean => {
    const url = request?.url || '';
    if (url.startsWith(PAYSTACK_CALLBACK_URL)) {
      completeFromUrl(url);
      return false; // don't actually navigate to the sentinel
    }
    return true;
  };

  // Backup detection in case the request interceptor doesn't fire.
  const handleNavigationChange = (navState: any) => {
    const url = navState?.url || '';
    if (url.startsWith(PAYSTACK_CALLBACK_URL)) {
      completeFromUrl(url);
    }
  };

  const handleWebViewMessage = async (event: any) => {
    if (processedRef.current) return;

    try {
      const data = JSON.parse(event.nativeEvent.data);

      if (data.status === 'cancelled') {
        navigation.goBack();
        return;
      }

      if (data.status === 'success' && data.reference) {
        processedRef.current = true;
        setVerifying(true);
        await handlePaymentSuccess(data.reference);
      }
    } catch (e) {
      // ignore
    }
  };

  const handlePaymentSuccess = async (reference: string) => {
    try {
      const verification = await paystackService.verifyTransaction(reference);

      if (!verification.success) {
        Alert.alert(
          'Verification Failed',
          `${verification.error || 'Could not verify payment.'}\n\nIf you were charged, your wallet will still be credited automatically.`,
          [{ text: 'OK', onPress: () => navigation.goBack() }],
        );
        return;
      }

      const txData = verification.data;

      if (txData?.status !== 'success') {
        Alert.alert('Payment Not Successful', 'Please try again.', [
          { text: 'OK', onPress: () => navigation.goBack() },
        ]);
        return;
      }

      // The wallet is credited server-side during verification (idempotently),
      // so there is nothing to do on the client but confirm.
      Alert.alert(
        'Funding Successful',
        `₦${txData.amount.toLocaleString()} has been added to your wallet.`,
        [{ text: 'OK', onPress: () => navigation.popToTop() }],
      );
    } catch (err: any) {
      Alert.alert('Error', 'An error occurred. Please contact support.', [
        { text: 'OK', onPress: () => navigation.goBack() },
      ]);
    }
  };

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <StatusBar barStyle="dark-content" backgroundColor={Colors.WHITE} />
        <ActivityIndicator size="large" color={Colors.GREEN} />
        <Text style={styles.loadingText}>Preparing payment...</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.loadingContainer}>
        <StatusBar barStyle="dark-content" backgroundColor={Colors.WHITE} />
        <Text style={styles.errorIcon}>⚠️</Text>
        <Text style={styles.errorTitle}>Payment Error</Text>
        <Text style={styles.errorText}>{error}</Text>
        <TouchableOpacity style={styles.retryButton} onPress={initPayment}>
          <Text style={styles.retryButtonText}>Try Again</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.cancelButton} onPress={() => navigation.goBack()}>
          <Text style={styles.cancelButtonText}>Cancel</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (verifying) {
    return (
      <View style={styles.loadingContainer}>
        <StatusBar barStyle="dark-content" backgroundColor={Colors.WHITE} />
        <ActivityIndicator size="large" color={Colors.GREEN} />
        <Text style={styles.loadingText}>Verifying payment...</Text>
        <Text style={styles.loadingSubtext}>Please don't close the app</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor={Colors.WHITE} />
      {authorizationUrl && (
        <WebView
          source={{
            uri: authorizationUrl,
            headers: {
              'User-Agent':
                'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
            },
          }}
          style={styles.webview}
          onMessage={handleWebViewMessage}
          onNavigationStateChange={handleNavigationChange}
          onShouldStartLoadWithRequest={handleShouldStartLoad}
          javaScriptEnabled
          domStorageEnabled
          onError={() => setError('Failed to load payment page.')}
          onLoadStart={() => {}}
          onLoadEnd={() => {}}
        />
      )}
      <TouchableOpacity
        style={styles.floatingBack}
        onPress={() => navigation.goBack()}
        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
      >
        <Text style={styles.floatingBackText}>✕</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.WHITE },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: Colors.WHITE,
    paddingHorizontal: Spacing.XL,
  },
  loadingText: { ...Typography.BODY, marginTop: Spacing.M, color: Colors.DARK, textAlign: 'center' },
  loadingSubtext: { ...Typography.CAPTION, marginTop: Spacing.S, color: Colors.GRAY, textAlign: 'center' },
  errorIcon: { fontSize: 48, marginBottom: Spacing.M },
  errorTitle: { ...Typography.HEADING, marginBottom: Spacing.S, color: Colors.DARK, textAlign: 'center' },
  errorText: { ...Typography.BODY, textAlign: 'center', color: Colors.GRAY, marginBottom: Spacing.XL },
  retryButton: {
    backgroundColor: Colors.GREEN,
    height: Spacing.BUTTON_HEIGHT_PRIMARY,
    borderRadius: Spacing.BUTTON_RADIUS,
    justifyContent: 'center',
    alignItems: 'center',
    width: '100%',
    marginBottom: Spacing.M,
  },
  retryButtonText: { ...Typography.BUTTON_TEXT, color: Colors.WHITE },
  cancelButton: {
    height: Spacing.BUTTON_HEIGHT_PRIMARY,
    borderRadius: Spacing.BUTTON_RADIUS,
    justifyContent: 'center',
    alignItems: 'center',
    width: '100%',
  },
  cancelButtonText: { ...Typography.BUTTON_TEXT, color: Colors.GRAY },
  webview: { flex: 1 },
  floatingBack: {
    position: 'absolute',
    top: 48,
    left: 16,
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 20,
  },
  floatingBackText: { color: Colors.WHITE, fontSize: 18, fontWeight: '600' },
});
