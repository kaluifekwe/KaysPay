import * as Application from 'expo-application';
import * as Crypto from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';
import { AppState, Platform } from 'react-native';
import { supabase } from '../lib/supabase';
import { StorageKeys, storageHelpers } from '../lib/mmkv';

export type AnalyticsEventType =
  | 'app_opened' | 'onboarding_started' | 'onboarding_slide_viewed' | 'onboarding_skipped'
  | 'registration_started' | 'registration_validation_failed' | 'registration_submitted'
  | 'account_created' | 'email_verification_started' | 'email_verification_failed' | 'email_verified'
  // pin_setup_completed had no failed counterpart -- a PIN mismatch, or the
  // save itself failing after 4 retries, were both real observed outcomes
  // (the retry-exhausted case only ever hit console.warn) but neither was
  // ever recorded, leaving this step's drop-off with zero failure signal.
  | 'pin_setup_completed' | 'pin_setup_failed' | 'biometric_offer_completed' | 'home_viewed'
  // kyc_started only ever fired on a full 11-digit submission, so "Home
  // reached -> KYC started" couldn't tell "never opened the screen" apart
  // from "opened it and abandoned before finishing" -- kyc_viewed closes
  // that gap by firing the moment the screen renders, regardless of outcome.
  | 'kyc_viewed' | 'kyc_started'
  | 'kyc_failed' | 'kyc_completed' | 'funding_viewed' | 'funding_started'
  | 'funding_failed' | 'first_funding_completed' | 'first_purchase_completed'
  // Started/failed for the 4 purchase flows that had no instrumentation at
  // all — until now there was no way to tell "opened the screen and left"
  // apart from "started buying and the provider rejected it". No
  // crypto_buy_completed: unlike the other three, a buy settles later via a
  // provider webhook the client is not reliably present for, and true
  // completion is already known authoritatively server-side (the
  // transactions-table trigger that drives first_purchase_at) — a client
  // "completed" event here would just be guessing.
  | 'crypto_buy_started' | 'crypto_buy_failed'
  | 'foreign_number_started' | 'foreign_number_failed' | 'foreign_number_completed'
  | 'nin_services_started' | 'nin_services_failed' | 'nin_services_completed'
  | 'esim_started' | 'esim_failed' | 'esim_completed'
  // Same "no completed" reasoning as crypto_buy above — success is already
  // visible via the transactions table. What was missing was any trace of a
  // purchase that failed BEFORE a transaction row ever existed (e.g. a
  // stale data catalog), which is invisible everywhere else.
  | 'data_started' | 'data_failed'
  | 'airtime_started' | 'airtime_failed'
  | 'electricity_started' | 'electricity_failed'
  | 'tv_started' | 'tv_failed';

type AnalyticsOutcome = 'view' | 'started' | 'completed' | 'failed' | 'skipped';
type MetadataKey = 'slide_index' | 'entry_point' | 'verification_method' | 'funding_method';

interface QueuedEvent {
  event_id: string;
  session_id: string;
  event_type: AnalyticsEventType;
  outcome?: AnalyticsOutcome;
  occurred_at: string;
  failure_code?: string;
  metadata?: Partial<Record<MetadataKey, string | number | boolean>>;
}

interface TrackOptions {
  outcome?: AnalyticsOutcome;
  failureCode?: string;
  metadata?: Partial<Record<MetadataKey, string | number | boolean>>;
}

const ANALYTICS_DIR = new Directory(Paths.document, 'kp_analytics');
const QUEUE_FILE = new File(ANALYTICS_DIR, 'queue.json');
const MAX_QUEUE_SIZE = 100;
const MAX_EVENT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const sessionId = Crypto.randomUUID();

// installationId is a random, non-PII identifier scoped to this app install.
// It is used solely for analytics aggregation (grouping events by install)
// and is never combined with personal data. It is cleared on sign-out so a
// different account signing in later gets a fresh identity.
let installationId: string | null = null;
let initialized = false;
let flushing = false;
let operation = Promise.resolve();
let consecutiveFailures = 0;
let nextFlushAt = 0;

function readQueue(): QueuedEvent[] {
  try {
    if (!QUEUE_FILE.exists) return [];
    const value = JSON.parse(QUEUE_FILE.textSync()) as unknown;
    if (!Array.isArray(value)) return [];
    const cutoff = Date.now() - MAX_EVENT_AGE_MS;
    return (value as QueuedEvent[])
      .filter((event) => new Date(event.occurred_at).getTime() >= cutoff)
      .slice(-MAX_QUEUE_SIZE);
  } catch {
    return [];
  }
}

function writeQueue(events: QueuedEvent[]): void {
  try {
    if (!ANALYTICS_DIR.exists) ANALYTICS_DIR.create({ intermediates: true, idempotent: true } as any);
    if (!QUEUE_FILE.exists) QUEUE_FILE.create({ idempotent: true } as any);
    QUEUE_FILE.write(JSON.stringify(events.slice(-MAX_QUEUE_SIZE)));
  } catch {
    // Analytics must never interrupt onboarding or a financial operation.
  }
}

function osMajorVersion(): number | null {
  const match = String(Platform.Version).match(/^\d+/);
  const value = match ? Number(match[0]) : NaN;
  return Number.isInteger(value) && value >= 7 && value <= 100 ? value : null;
}

function locale(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || null;
  } catch {
    return null;
  }
}

async function ensureInstallationId(): Promise<string> {
  if (installationId) return installationId;
  installationId = await storageHelpers.getString(StorageKeys.ANALYTICS_INSTALLATION_ID) || Crypto.randomUUID();
  await storageHelpers.setString(StorageKeys.ANALYTICS_INSTALLATION_ID, installationId);
  return installationId;
}

async function flushInternal(): Promise<void> {
  if (flushing || Date.now() < nextFlushAt) return;
  const queue = readQueue();
  if (queue.length === 0) return;
  flushing = true;
  try {
    const id = await ensureInstallationId();
    const batch = queue.slice(0, 20);
    const { error } = await supabase.functions.invoke('analytics-ingest', {
      method: 'POST',
      body: {
        installation_id: id,
        app_version: Application.nativeApplicationVersion || undefined,
        build_number: Application.nativeBuildVersion || undefined,
        platform: Platform.OS === 'android' || Platform.OS === 'ios' || Platform.OS === 'web' ? Platform.OS : 'unknown',
        os_major: osMajorVersion(),
        network_type: 'unknown',
        locale: locale(),
        events: batch,
      },
    });
    if (!error) {
      consecutiveFailures = 0;
      nextFlushAt = 0;
      const acceptedIds = new Set(batch.map((event) => event.event_id));
      writeQueue(readQueue().filter((event) => !acceptedIds.has(event.event_id)));
      if (readQueue().length > 0) void flush();
    } else {
      consecutiveFailures += 1;
      nextFlushAt = Date.now() + Math.min(60_000, 1000 * (2 ** Math.min(consecutiveFailures - 1, 6)));
    }
  } catch {
    // Retain the bounded queue for the next app activation/event.
    consecutiveFailures += 1;
    nextFlushAt = Date.now() + Math.min(60_000, 1000 * (2 ** Math.min(consecutiveFailures - 1, 6)));
  } finally {
    flushing = false;
  }
}

export function flush(): Promise<void> {
  operation = operation.then(flushInternal, flushInternal);
  return operation;
}

export function track(eventType: AnalyticsEventType, options: TrackOptions = {}): Promise<void> {
  operation = operation.then(async () => {
    await ensureInstallationId();
    const queue = readQueue();
    queue.push({
      event_id: Crypto.randomUUID(),
      session_id: sessionId,
      event_type: eventType,
      outcome: options.outcome,
      occurred_at: new Date().toISOString(),
      failure_code: options.failureCode,
      metadata: options.metadata,
    });
    writeQueue(queue);
    await flushInternal();
  }).catch(() => {});
  return operation;
}

export function initializeAnalytics(): () => void {
  if (!initialized) {
    initialized = true;
    void track('app_opened', { outcome: 'view' });
  } else {
    void flush();
  }
  const subscription = AppState.addEventListener('change', (state) => {
    if (state === 'active') void flush();
  });
  return () => subscription.remove();
}

export async function clearAnalyticsState(): Promise<void> {
  installationId = null;
  await storageHelpers.delete(StorageKeys.ANALYTICS_INSTALLATION_ID);
}

// Fires 'first_purchase_completed' the first time this device ever sees a
// completed purchase, then never again. Centralised here — one call site per
// purchase-success point, instead of each screen re-implementing its own
// "was this the first" check — specifically because the *other* first-time
// funnel events (pin_setup, first_funding) drifted or went unwired when that
// logic lived separately in each screen. Persisted via storageHelpers rather
// than an in-memory ref: unlike first_funding_completed's balance-crossing-
// zero check (which only knows "first time observed in this sitting" and can
// misfire again after a balance later returns to zero), this needs to stay
// true for the life of the install, across app restarts.
export async function trackFirstPurchaseIfNeeded(): Promise<void> {
  const already = await storageHelpers.getBoolean(StorageKeys.HAS_COMPLETED_FIRST_PURCHASE);
  if (already) return;
  await storageHelpers.setBoolean(StorageKeys.HAS_COMPLETED_FIRST_PURCHASE, true);
  void track('first_purchase_completed', { outcome: 'completed' });
}

export const analytics = { track, flush, trackFirstPurchaseIfNeeded };
