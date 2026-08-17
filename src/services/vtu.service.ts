import { supabase } from '../lib/supabase';
import { nairaToKobo } from '../utils/formatCurrency';
import { withTimeout, invokeWithRetry } from '../utils/network';
import { readCache, writeCache } from '../utils/cache';

export type NetworkProvider = 'mtn' | 'airtel' | 'glo' | '9mobile';

export interface DataBundle {
  id: string;
  name: string;
  amount: number;
  /** Pre-discount reference price for a "was/now" display — only present
   * on an auto-priced plan (never a manually-overridden one), and only
   * when it's actually higher than `amount`. */
  list_amount?: number | null;
  /** Whether this plan earns cashback — deliberately no amount here, only
   * shown once actually credited after a purchase. */
  has_cashback?: boolean;
  validity: string;
  network: NetworkProvider;
}

export interface ElectricityProvider {
  id: string;
  name: string;
  type: 'prepaid' | 'postpaid';
}

export type TVServiceProvider = 'dstv' | 'gotv' | 'startimes';

export interface TVProvider {
  id: TVServiceProvider;
  name: string;
}

export interface TVBouquet {
  id: string;
  name: string;
  amount: number;
  validity: string;
}

export interface ExamType {
  id: string;
  name: string;
  amount: number;
  quantity_options: number[];
  requiresProfileCode?: boolean;
}

export interface VTUResult {
  success: boolean;
  order_id?: string;
  message?: string;
  error?: string;
  // Airtime (VTUnaija) is normally synchronous, but an ambiguous/unclear
  // provider response is held pending rather than guessed; data (still on
  // VTUnaija data catalog; other services can be
  // genuinely async. `pending` means "not failed, just not final yet"; it'll
  // complete or refund on its own shortly after.
  pending?: boolean;
  // The server transaction id — lets the result screen poll this purchase
  // until it settles (used by the Processing -> Successful status screen).
  transaction_id?: string;
  code?: 'PRICE_CHANGED' | 'PLAN_DISABLED' | 'AVAILABILITY_UNAVAILABLE';
  current_amount?: number;
  pins?: string[];
  serials?: string[];
  // Naira, set only when this purchase actually credited cashback — never
  // an estimate, always what the server confirmed was added to the balance.
  cashbackEarned?: number;
}

export interface BatchAirtimeRecipient {
  phone: string;
  network: NetworkProvider;
  amount: number; // naira
}

export interface BatchDataRecipient {
  phone: string;
  network: NetworkProvider;
  bundle: DataBundle;
}

export interface BatchResultItem {
  phone: string;
  success: boolean;
  // The provider now settles in the background, so a freshly-submitted order
  // comes back success+pending: accepted, not yet confirmed delivered. The
  // bulk screen polls `transaction_id` until it flips to a terminal state so a
  // later refund is never hidden behind a premature ✓.
  pending?: boolean;
  transaction_id?: string;
  order_id?: string;
  error?: string;
}

const airtimeAmounts = [100, 200, 300, 500, 1000, 2000, 3000, 5000, 10000, 15000, 20000];

// Small fallback list, used only when the live vtunaija-data-catalog fetch
// fails and the cache is empty. Real sample from VTUnaija's /listdataplans/
// response (confirmed live, 2026-08-03) — ids/names/prices match what the
// live sync would store for these specific plans (price_for_premiumuser
// tier, per owner confirmation). Not the full 178-plan catalog — just enough
// to keep the Data screen usable during a provider hiccup.
const fallbackDataBundles: DataBundle[] = [
  { id: 'vtunaija-mtn-121', name: '1GB DataShare (DataShare)', amount: 460, validity: '7 Days', network: 'mtn' },
  { id: 'vtunaija-mtn-122', name: '2GB Datashare (DataShare)', amount: 1040, validity: '30 Days', network: 'mtn' },
  { id: 'vtunaija-glo-22', name: '500 MB (Corporate)', amount: 190, validity: '30 Days', network: 'glo' },
  { id: 'vtunaija-glo-23', name: '1 GB (Corporate)', amount: 380, validity: '30 Days', network: 'glo' },
  { id: 'vtunaija-airtel-28', name: '500 MB (Corporate)', amount: 489, validity: '7 Days', network: 'airtel' },
  { id: 'vtunaija-airtel-29', name: '1 GB (Corporate)', amount: 782.4, validity: '7 Days', network: 'airtel' },
  { id: 'vtunaija-9mobile-219', name: '9mobile 100MB - 100 Naira (GiftingPlan)', amount: 100.55, validity: '1 Days', network: '9mobile' },
  { id: 'vtunaija-9mobile-220', name: '9mobile 650MB - 200 Naira (GiftingPlan)', amount: 200.10, validity: '1 Days', network: '9mobile' },
];

// App-facing identifiers for the supported electricity distributors.
// (cross-checked live, 2026-07-03) — electricity now routes through
// Provider mapping is resolved server-side from VTUnaija's live catalog.
const electricityProviders: ElectricityProvider[] = [
  { id: 'ikeja-electric', name: 'Ikeja Electric (IKEDC)', type: 'prepaid' },
  { id: 'eko-electric', name: 'Eko Electricity (EKEDC)', type: 'prepaid' },
  { id: 'ibadan-electric', name: 'Ibadan Electricity (IBEDC)', type: 'prepaid' },
  { id: 'portharcourt-electric', name: 'Port Harcourt (PHEDC)', type: 'prepaid' },
  { id: 'kaduna-electric', name: 'Kaduna Electricity (KEDC)', type: 'prepaid' },
  { id: 'kano-electric', name: 'Kano Electricity (KEDCO)', type: 'prepaid' },
  { id: 'jos-electric', name: 'Jos Electricity (JEDC)', type: 'prepaid' },
  { id: 'abuja-electric', name: 'Abuja Electricity (AEDC)', type: 'prepaid' },
  { id: 'enugu-electric', name: 'Enugu Electricity (EEDC)', type: 'prepaid' },
  { id: 'benin-electric', name: 'Benin Electricity (BEDC)', type: 'prepaid' },
  { id: 'aba-electric', name: 'Aba Electricity (ABEDC)', type: 'prepaid' },
  { id: 'yola-electric', name: 'Yola Electricity (YEDC)', type: 'prepaid' },
];

const electricityCatalogCacheKey = 'vtunaija_electricity_catalog';

// Exact names returned by VTUnaija's live catalogue. Customer-facing labels
// stay concise, while this lookup ensures only provider-backed options show.
const electricityProviderIdsByVtunaijaName = new Map<string, string>([
  ['Ikeja Electricity Distribution Company', 'ikeja-electric'],
  ['Eko Electricity Distribution Company', 'eko-electric'],
  ['Kano Electricity Distribution Company (KEDCO)', 'kano-electric'],
  ['Port Harcourt Electricity Distribution Company (PHED)', 'portharcourt-electric'],
  ['Jos Electricity Distribution Company', 'jos-electric'],
  ['Ibadan Electricity Distribution Company (IBEDC)', 'ibadan-electric'],
  ['Kaduna Electricity Distribution Company (KEDCO)', 'kaduna-electric'],
  ['Abuja Electricity Distribution Company (AEDC)', 'abuja-electric'],
  ['Enugu Electricity Distribution Company (EEDC)', 'enugu-electric'],
  ['Benin Electricity Distribution Company (BEDC)', 'benin-electric'],
  ['Yola Electricity Distribution Company', 'yola-electric'],
  ['Aba Electricity Distribution Company', 'aba-electric'],
]);

function cachedElectricityProviders(): ElectricityProvider[] {
  const cached = readCache<ElectricityProvider[]>(electricityCatalogCacheKey);
  return cached?.data?.length ? cached.data : electricityProviders;
}

export interface SavedBillingAccount {
  id: string;
  service: 'tv' | 'electricity';
  provider_id: string;
  account_number: string;
  customer_name: string;
  customer_address: string | null;
  /**
   * Last verification snapshot, cached server-side so a saved card can show
   * its full details immediately. Null until that card has been verified
   * since this was introduced. Display only — the purchase endpoint ignores
   * anything older than 5 minutes and re-verifies.
   */
  due_date: string | null;
  /** KOBO. Divide by 100 before showing; formatNaira expects naira. */
  renewal_amount_kobo: number | null;
  last_verified_at: string;
  last_used_at: string;
}

async function refreshElectricityProviders(force = false): Promise<ElectricityProvider[]> {
  const cached = readCache<ElectricityProvider[]>(electricityCatalogCacheKey);
  if (!force && cached?.data?.length && Date.now() - cached.savedAt < 60 * 1000) return cached.data;

  try {
    const { data, error } = await withTimeout(
      supabase.functions.invoke('vtunaija-electricity-catalog', { body: { health: true } }),
      12_000,
    );
    if (error || !data?.healthy || !Array.isArray(data.rows)) return cachedElectricityProviders();

    const availableIds = new Set<string>();
    for (const row of data.rows as { name?: unknown }[]) {
      if (typeof row?.name !== 'string') continue;
      const id = electricityProviderIdsByVtunaijaName.get(row.name);
      if (id) availableIds.add(id);
    }
    const providers = electricityProviders.filter((provider) => availableIds.has(provider.id));
    if (providers.length === 0) return cachedElectricityProviders();

    writeCache(electricityCatalogCacheKey, providers);
    return providers;
  } catch {
    return cachedElectricityProviders();
  }
}

// Just the 3 supported provider cards — bouquets are fetched live from
// vtunaija-cabletv-catalog (see refreshBouquets below), the same
// cache-then-refresh pattern DataScreen already uses for data bundles.
// Showmax exists on VTUnaija's side but isn't a supported provider here.
const tvProviders: TVProvider[] = [
  { id: 'dstv', name: 'DStv' },
  { id: 'gotv', name: 'GOtv' },
  { id: 'startimes', name: 'Startimes' },
];

// Small fallback list, used only when the live vtunaija-cabletv-catalog
// fetch fails and the cache is empty. Real sample from VTUnaija's
// /listcabletvplans/ response (confirmed live, 2026-08-03).
const fallbackBouquets: Record<TVServiceProvider, TVBouquet[]> = {
  gotv: [
    { id: 'vtunaija-gotv-1', name: 'GOtv Smallie - monthly N1900', amount: 1900, validity: '30 Days' },
    { id: 'vtunaija-gotv-2', name: 'GOtv Jinja N3,900', amount: 3900, validity: '30 Days' },
  ],
  dstv: [
    { id: 'vtunaija-dstv-6', name: 'DStv Padi N4,400', amount: 4400, validity: '30 Days' },
    { id: 'vtunaija-dstv-7', name: 'DStv Yanga N6,000', amount: 6000, validity: '30 Days' },
  ],
  startimes: [
    { id: 'vtunaija-startimes-13', name: 'Nova (Dish) - 2100 Naira - 1 Month', amount: 2100, validity: '30 Days' },
    { id: 'vtunaija-startimes-14', name: 'Basic (Antenna) - 4,000 Naira - 1 Month', amount: 4000, validity: '30 Days' },
  ],
};

// Exact six-product catalog documented by VTUnaija. Quantity is restricted
// to one until the provider confirms how multiple PIN/serial pairs are
// returned. Prices mirror the active premium tier used server-side.
const examTypes: ExamType[] = [
  { id: 'waec', name: 'WAEC Exam PIN', amount: 5080, quantity_options: [1] },
  { id: 'neco', name: 'NECO Exam PIN', amount: 2090, quantity_options: [1] },
  { id: 'nabteb', name: 'NABTEB Exam PIN', amount: 880, quantity_options: [1] },
  { id: 'jamb', name: 'JAMB Exam PIN', amount: 15000, quantity_options: [1] },
  { id: 'waec-registration', name: 'WAEC Registration PIN', amount: 15000, quantity_options: [1] },
  { id: 'nbais', name: 'NBAIS Exam PIN', amount: 1050, quantity_options: [1] },
];

const examCatalogCacheKey = 'vtunaija_exam_catalog';

function cachedExamTypes(): ExamType[] {
  const cached = readCache<ExamType[]>(examCatalogCacheKey);
  return cached?.data?.length ? cached.data : examTypes;
}

async function refreshExamTypes(force = false): Promise<ExamType[]> {
  const cached = readCache<ExamType[]>(examCatalogCacheKey);
  if (!force && cached?.data?.length && Date.now() - cached.savedAt < 60 * 1000) return cached.data;
  try {
    const { data, error } = await withTimeout(
      supabase.functions.invoke('vtunaija-exam-catalog', { body: {} }),
      12_000,
    );
    if (error || !data?.success || !Array.isArray(data.exams) || data.exams.length === 0) return cachedExamTypes();
    const exams = data.exams.filter((exam: ExamType) =>
      typeof exam.id === 'string' && typeof exam.name === 'string' &&
      Number.isFinite(exam.amount) && exam.amount > 0 &&
      Array.isArray(exam.quantity_options) && exam.quantity_options.length === 1 && exam.quantity_options[0] === 1
    ) as ExamType[];
    if (exams.length === 0) return cachedExamTypes();
    writeCache(examCatalogCacheKey, exams);
    return exams;
  } catch {
    return cachedExamTypes();
  }
}

/**
 * Generate a client-side idempotency key so a double-tap / retry of the same
 * purchase maps to the same server transaction (the server enforces this).
 */
function newIdempotencyKey(): string {
  return `ksp_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * All purchases go through the `vtu-purchase` Edge Function. The wallet debit,
 * provider call (with the secret API key) and refund-on-failure all happen
 * server-side — the client never moves money or holds provider credentials.
 */
async function purchase(
  body: Record<string, unknown>,
  authToken: string,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<VTUResult & { token?: string; pins?: string[]; units?: string }> {
  try {
    // Generated ONCE, before the call — invokeWithRetry uses this to check
    // whether an earlier attempt already succeeded server-side before ever
    // resubmitting (the PIN auth_token is single-use and gets consumed the
    // moment a request reaches the server, so blindly resubmitting on an
    // ambiguous network failure can hit "already used" even when the
    // original attempt actually went through — see network.ts).
    //
    // The caller may pass its own key so it can watch the resulting transaction
    // by `metadata->>idempotency_key` WITHOUT waiting for this call's response
    // — the "fire-and-watch" flow that keeps the UI responsive on poor networks
    // (the phone never blocks on the long provider round-trip).
    const { data, error } = await invokeWithRetry<any>(
      () =>
        withTimeout(
          supabase.functions.invoke('vtu-purchase', {
            body: { ...body, auth_token: authToken, idempotency_key: idempotencyKey },
          }),
        ),
      idempotencyKey,
    );

    if (error) {
      // supabase.functions.invoke hides the Edge Function's own JSON error
      // body behind a generic message on any non-2xx — dig out the real one.
      let msg = 'Service temporarily unavailable. Please try again.';
      try {
        const errBody = await (error as any)?.context?.json?.();
        if (errBody?.error) msg = errBody.error;
        if (errBody?.code) return { success: false, error: msg, code: errBody.code };
      } catch {}
      return { success: false, error: msg };
    }
    if (!data?.success) {
      return {
        success: false,
        error: data?.error || 'Transaction failed',
        code: data?.code,
        current_amount: data?.current_amount,
      };
    }

    return {
      success: true,
      pending: data.pending,
      message: data.message,
      order_id: data.order_id,
      transaction_id: data.transaction_id,
      token: data.token,
      pins: data.pins,
      serials: data.serials,
      units: data.units,
      cashbackEarned: data.cashback_earned_kobo ? data.cashback_earned_kobo / 100 : undefined,
    };
  } catch {
    return { success: false, error: 'Network error. Please try again.' };
  }
}

function dataCatalogCacheKey(network: NetworkProvider): string {
  return `vtu_data_catalog_${network}`;
}

function cachedDataBundles(network: NetworkProvider): DataBundle[] {
  const cached = readCache<DataBundle[]>(dataCatalogCacheKey(network));
  if (cached && Array.isArray(cached.data)) return cached.data;
  return fallbackDataBundles.filter((bundle) => bundle.network === network);
}

// Whether a REAL synced catalog is cached for this network, as opposed to
// only the small hardcoded fallback list. cachedDataBundles() always returns
// a non-empty array (falling back when there's nothing real yet), so a
// plain length check can't tell "first load, showing placeholders" apart
// from "real data, already loaded" — this can.
function hasCachedDataBundles(network: NetworkProvider): boolean {
  const cached = readCache<DataBundle[]>(dataCatalogCacheKey(network));
  return !!cached && Array.isArray(cached.data);
}

async function refreshDataBundles(network: NetworkProvider, force = false): Promise<DataBundle[]> {
  const cached = readCache<DataBundle[]>(dataCatalogCacheKey(network));
  if (!force && cached && Array.isArray(cached.data) && Date.now() - cached.savedAt < 60 * 1000) return cached.data;
  try {
    const { data, error } = await withTimeout(
      supabase.functions.invoke('vtunaija-data-catalog', { body: { network } }),
      12_000,
    );
    if (error || !data?.success || !Array.isArray(data.plans)) {
      return cachedDataBundles(network);
    }
    const plans = data.plans.filter((plan: DataBundle) =>
      plan?.network === network && typeof plan.id === 'string' && typeof plan.name === 'string' &&
      Number.isFinite(plan.amount) && plan.amount > 0
    ) as DataBundle[];
    writeCache(dataCatalogCacheKey(network), plans);
    return plans;
  } catch {
    return cachedDataBundles(network);
  }
}

function bouquetCacheKey(provider: TVServiceProvider): string {
  return `vtu_cabletv_catalog_${provider}`;
}

function cachedBouquets(provider: TVServiceProvider): TVBouquet[] {
  const cached = readCache<TVBouquet[]>(bouquetCacheKey(provider));
  if (cached?.data?.length) return cached.data;
  return fallbackBouquets[provider];
}

async function refreshBouquets(provider: TVServiceProvider): Promise<TVBouquet[]> {
  const cached = readCache<TVBouquet[]>(bouquetCacheKey(provider));
  if (cached?.data?.length && Date.now() - cached.savedAt < 5 * 60 * 1000) return cached.data;
  try {
    const { data, error } = await withTimeout(
      supabase.functions.invoke('vtunaija-cabletv-catalog', { body: { provider } }),
      12_000,
    );
    if (error || !data?.success || !Array.isArray(data.bouquets) || data.bouquets.length === 0) {
      return cachedBouquets(provider);
    }
    const bouquets = data.bouquets.filter((b: TVBouquet) =>
      typeof b.id === 'string' && typeof b.name === 'string' &&
      Number.isFinite(b.amount) && b.amount > 0
    ) as TVBouquet[];
    if (bouquets.length === 0) return cachedBouquets(provider);
    writeCache(bouquetCacheKey(provider), bouquets);
    return bouquets;
  } catch {
    return cachedBouquets(provider);
  }
}

export const vtuService = {
  /**
   * Ask the server to verify a single pending VTUnaija order now
   * and settle it if there's a final answer — so the result screen flips to
   * Successful/Failed the moment the provider confirms, instead of waiting for
   * the periodic reconcile sweep. Returns the order's status; falls back to
   * 'pending' on any error so the caller simply keeps polling.
   */
  async verifyOrder(transactionId: string): Promise<'completed' | 'failed' | 'pending'> {
    try {
      const { data, error } = await withTimeout(
        supabase.functions.invoke('vtu-verify-order', { body: { transaction_id: transactionId } }),
      );
      if (error || !data?.status) return 'pending';
      return data.status === 'completed' || data.status === 'failed' ? data.status : 'pending';
    } catch {
      return 'pending';
    }
  },

  /**
   * A fresh idempotency key the caller can hold BEFORE firing a purchase, so it
   * can watch the resulting transaction by `metadata->>idempotency_key` without
   * waiting for the purchase call's (slow, on poor networks) response.
   */
  newRequestKey(): string {
    return newIdempotencyKey();
  },

  /**
   * The admin-set flat convenience fee (naira) added on top of whatever
   * amount a customer tops up on electricity (see migration 114) — fetched
   * fresh so the pre-payment total shown always matches what vtu-purchase
   * will actually charge. Falls back to 0 (no fee) on any failure; the
   * server independently re-derives the real fee at charge time regardless
   * of what this reports.
   */
  async getElectricityFee(): Promise<number> {
    try {
      const { data, error } = await withTimeout(supabase.functions.invoke('service-pricing'));
      if (error || !data?.success) return 0;
      const fee = Number(data.electricity_fee);
      return Number.isFinite(fee) && fee >= 0 ? fee : 0;
    } catch {
      return 0;
    }
  },

  getDataBundles(network: NetworkProvider): DataBundle[] {
    return cachedDataBundles(network);
  },

  hasCachedDataBundles(network: NetworkProvider): boolean {
    return hasCachedDataBundles(network);
  },

  refreshDataBundles(network: NetworkProvider, force = false): Promise<DataBundle[]> {
    return refreshDataBundles(network, force);
  },

  subscribeToDataAvailability(network: NetworkProvider, callback: () => void) {
    const channel = supabase
      .channel(`vtu-availability:${network}`)
      .on(
        'broadcast',
        { event: 'availability_changed' },
        callback,
      )
      .subscribe((status) => {
        // A toggle may happen while the WebSocket is still connecting. A
        // forced refresh at SUBSCRIBED closes that gap without polling.
        if (status === 'SUBSCRIBED') callback();
      });

    return {
      unsubscribe: () => { void supabase.removeChannel(channel); },
    };
  },

  applyDataPriceChange(network: NetworkProvider, bundleId: string, amount: number): void {
    if (!Number.isFinite(amount) || amount <= 0) return;
    const updated = cachedDataBundles(network).map((bundle) =>
      bundle.id === bundleId ? { ...bundle, amount } : bundle
    );
    writeCache(dataCatalogCacheKey(network), updated);
  },

  getAirtimeAmounts(): number[] {
    return airtimeAmounts;
  },

  getElectricityProviders(): ElectricityProvider[] {
    return cachedElectricityProviders();
  },

  refreshElectricityProviders(force = false): Promise<ElectricityProvider[]> {
    return refreshElectricityProviders(force);
  },

  /** Maps a biller id (stored in a transaction's metadata) back to its display name. */
  getElectricityProviderName(billerId: string): string {
    return electricityProviders.find((p) => p.id === billerId)?.name || billerId;
  },

  getTVProviders(): TVProvider[] {
    return tvProviders;
  },

  /** Cached bouquets for a provider — shows instantly while refreshBouquets fetches live prices, same pattern as getDataBundles/refreshDataBundles. */
  getBouquets(provider: TVServiceProvider): TVBouquet[] {
    return cachedBouquets(provider);
  },

  refreshBouquets(provider: TVServiceProvider): Promise<TVBouquet[]> {
    return refreshBouquets(provider);
  },

  getExamTypes(): ExamType[] {
    return cachedExamTypes();
  },

  refreshExamTypes(force = false): Promise<ExamType[]> {
    return refreshExamTypes(force);
  },

  buyAirtime(phone: string, network: NetworkProvider, amount: number, authToken: string, idempotencyKey?: string): Promise<VTUResult> {
    // amount is naira from the UI; the server ledger works in kobo.
    return purchase({ service: 'airtime', phone, network, amount: nairaToKobo(amount) }, authToken, idempotencyKey);
  },

  buyData(
    phone: string,
    network: NetworkProvider,
    bundle: DataBundle,
    authToken: string,
    idempotencyKey?: string,
    useCashback?: boolean,
  ): Promise<VTUResult> {
    return purchase({
      service: 'data',
      phone,
      network,
      bundle_id: bundle.id,
      quoted_amount_kobo: nairaToKobo(bundle.amount),
      use_cashback: useCashback === true,
    }, authToken, idempotencyKey);
  },

  /**
   * Sends airtime to several recipients one at a time (not in parallel, so
   * wallet debits stay ordered and we don't hammer the provider). Each call
   * reuses buyAirtime, so every recipient still gets its own idempotency key
   * via the existing vtu-purchase Edge Function — no server changes needed.
   * `authToken` must have been minted with maxUses >= recipients.length
   * (see TransactionAuthProvider's `maxUses` option) since one PIN entry
   * authorizes the whole batch.
   */
  async buyAirtimeBatch(
    recipients: BatchAirtimeRecipient[],
    authToken: string,
    onProgress?: (index: number, result: BatchResultItem) => void,
  ): Promise<BatchResultItem[]> {
    const results: BatchResultItem[] = [];
    for (let i = 0; i < recipients.length; i++) {
      const r = recipients[i];
      const res = await vtuService.buyAirtime(r.phone, r.network, r.amount, authToken);
      const item: BatchResultItem = {
        phone: r.phone,
        success: res.success,
        pending: res.pending,
        transaction_id: res.transaction_id,
        order_id: res.order_id,
        error: res.error,
      };
      results.push(item);
      onProgress?.(i, item);
    }
    return results;
  },

  async buyDataBatch(
    recipients: BatchDataRecipient[],
    authToken: string,
    onProgress?: (index: number, result: BatchResultItem) => void,
    // Applied per-recipient, in order — the server always computes the real
    // amount from the actual stored balance (LEAST(balance, price)), so once
    // it's spent, later recipients in the same batch simply apply nothing
    // rather than erroring or double-spending. Same discipline as buyData's
    // single-purchase useCashback.
    useCashback?: boolean,
  ): Promise<BatchResultItem[]> {
    const results: BatchResultItem[] = [];
    for (let i = 0; i < recipients.length; i++) {
      const r = recipients[i];
      const res = await vtuService.buyData(r.phone, r.network, r.bundle, authToken, undefined, useCashback);
      const item: BatchResultItem = {
        phone: r.phone,
        success: res.success,
        pending: res.pending,
        transaction_id: res.transaction_id,
        order_id: res.order_id,
        error: res.error,
      };
      results.push(item);
      onProgress?.(i, item);
    }
    return results;
  },

  buyElectricity(
    providerId: string,
    meterNumber: string,
    amount: number,
    type: 'prepaid' | 'postpaid',
    authToken: string,
    idempotencyKey?: string,
    customerName?: string,
    customerAddress?: string,
    // The topup + convenience fee total shown/confirmed on the Electricity
    // screen — lets the server detect a fee change between confirm and
    // charge and force a re-confirm instead of silently charging more.
    quotedTotalNaira?: number,
  ): Promise<VTUResult & { token?: string; units?: string }> {
    return purchase({
      service: 'electricity',
      provider_id: providerId,
      meter_number: meterNumber,
      amount: nairaToKobo(amount),
      type,
      ...(customerName ? { customer_name: customerName } : {}),
      ...(customerAddress ? { customer_address: customerAddress } : {}),
      ...(quotedTotalNaira != null ? { quoted_amount_kobo: nairaToKobo(quotedTotalNaira) } : {}),
    }, authToken, idempotencyKey);
  },

  /**
   * Pre-payment check: confirms a meter number resolves to a real customer
   * BEFORE any money moves, via VTUnaija's own /billpayment/verify/ lookup.
   * Read-only — safe to call on every meter-number edit. `ok: false` covers
   * both "this meter doesn't exist" and "couldn't reach the verify service
   * right now". The caller must not authorize payment until the server has a
   * fresh verification proof.
   */
  async getSavedBillingAccounts(
    service: 'tv' | 'electricity',
    providerId: string,
  ): Promise<SavedBillingAccount[]> {
    try {
      const accounts: SavedBillingAccount[] = [];
      for (let page = 0; page < 10; page += 1) {
        const { data, error } = await withTimeout(
          supabase.functions.invoke('billing-accounts', {
            body: { action: 'list', service, provider_id: providerId, page },
          }),
          12_000,
        );
        if (error || !data?.success || !Array.isArray(data.accounts)) return accounts;
        accounts.push(...data.accounts as SavedBillingAccount[]);
        if (data.has_more !== true) break;
      }
      return accounts;
    } catch {
      return [];
    }
  },

  async deleteSavedBillingAccount(id: string): Promise<boolean> {
    try {
      const { data, error } = await withTimeout(
        supabase.functions.invoke('billing-accounts', { body: { action: 'delete', id } }),
        12_000,
      );
      return !error && data?.success === true;
    } catch {
      return false;
    }
  },

  async verifyElectricityMeter(
    providerId: string,
    meterNumber: string,
  ): Promise<{ ok: boolean; customerName: string | null; customerAddress: string | null; error?: string }> {
    try {
      const { data, error } = await withTimeout(
        supabase.functions.invoke('verify-electricity-meter', {
          body: { provider_id: providerId, meter_number: meterNumber },
        }),
        12_000,
      );
      if (error || !data?.success) {
        return { ok: false, customerName: null, customerAddress: null, error: data?.error || 'Could not verify this meter number.' };
      }
      return { ok: true, customerName: data.customer_name ?? null, customerAddress: data.customer_address ?? null };
    } catch {
      return { ok: false, customerName: null, customerAddress: null, error: 'Could not verify this meter number.' };
    }
  },

  async verifyTVSmartcard(
    providerId: TVServiceProvider,
    smartcardNumber: string,
  ): Promise<{
    ok: boolean;
    customerName: string | null;
    accountStatus: string | null;
    dueDate: string | null;
    currentBouquet: string | null;
    renewalAmount: number | null;
    error?: string;
  }> {
    const failed = (error: string) => ({
      ok: false,
      customerName: null,
      accountStatus: null,
      dueDate: null,
      currentBouquet: null,
      renewalAmount: null,
      error,
    });
    try {
      const { data, error } = await withTimeout(
        supabase.functions.invoke('verify-tv-smartcard', {
          body: { provider_id: providerId, smartcard_number: smartcardNumber },
        }),
        12_000,
      );
      if (error || !data?.success) {
        return failed(data?.error || 'Could not verify this smartcard number.');
      }
      return {
        ok: true,
        customerName: data.customer_name ?? null,
        accountStatus: data.account_status ?? null,
        dueDate: data.due_date ?? null,
        currentBouquet: data.current_bouquet ?? null,
        renewalAmount: Number.isFinite(Number(data.renewal_amount)) ? Number(data.renewal_amount) : null,
      };
    } catch {
      return failed('Could not verify this smartcard number. Please try again.');
    }
  },

  buyTVSubscription(
    providerId: string,
    smartcardNumber: string,
    bouquetId: string,
    amount: number,
    authToken: string,
    idempotencyKey?: string,
  ): Promise<VTUResult> {
    // Price is resolved server-side from bouquetId; amount here is only the
    // last-quoted price the customer saw, sent so the server can detect a
    // drift (an admin price edit landing between quote and charge) and force
    // a re-confirm instead of silently charging the new price.
    return purchase({
      service: 'tv',
      provider_id: providerId,
      smartcard_number: smartcardNumber,
      bouquet_id: bouquetId,
      quoted_amount_kobo: nairaToKobo(amount),
    }, authToken, idempotencyKey);
  },

  buyExamPin(
    examType: ExamType,
    quantity: number,
    authToken: string,
    profileCode?: string,
    idempotencyKey?: string,
  ): Promise<VTUResult & { pins?: string[]; serials?: string[] }> {
    return purchase({
      service: 'exam_pin',
      exam_id: examType.id,
      quantity,
      quoted_amount_kobo: nairaToKobo(examType.amount * quantity),
      ...(profileCode ? { profile_code: profileCode } : {}),
    }, authToken, idempotencyKey);
  },
};
