import { supabase } from '../lib/supabase';
import { nairaToKobo } from '../utils/formatCurrency';
import { withTimeout, invokeWithRetry } from '../utils/network';
import { readCache, writeCache } from '../utils/cache';

export type NetworkProvider = 'mtn' | 'airtel' | 'glo' | '9mobile';

export interface DataBundle {
  id: string;
  name: string;
  amount: number;
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
  // VTU.ng pending VTUnaija's account_Id) and other services can be
  // genuinely async. `pending` means "not failed, just not final yet"; it'll
  // complete or refund on its own shortly after.
  pending?: boolean;
  // The server transaction id — lets the result screen poll this purchase
  // until it settles (used by the Processing -> Successful status screen).
  transaction_id?: string;
  code?: 'PRICE_CHANGED';
  current_amount?: number;
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

// Same 12 DISCO codes VTUAfrica's own pricing page confirms it supports
// (cross-checked live, 2026-07-03) — electricity now routes through
// VTUAfrica rather than VTU.ng.
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

// Routed to VTUAfrica's `/exam-pin` endpoint (VTU.ng never had a working
// exam pin integration). Ids match `_shared/vtu-catalog.ts`'s EXAM_PIN_TYPES
// exactly, confirmed live 2026-07-02. NECO GCE and NABTEB GCE are excluded —
// their listed prices (₦2 and ₦33) are clearly data errors on VTUAfrica's
// pricing page. JAMB PINs require a `profilecode` — the candidate's own
// JAMB profile code obtained directly from JAMB, not something we
// generate — and quantity is locked to 1 since one profile code can't cover
// multiple registration PINs in a single purchase.
const examTypes: ExamType[] = [
  { id: 'waec-result', name: 'WAEC Result Checking PIN', amount: 5000, quantity_options: [1, 2, 3, 4, 5] },
  { id: 'waec-verification', name: 'WAEC Verification PIN', amount: 4000, quantity_options: [1, 2, 3, 4, 5] },
  { id: 'waec-gce', name: 'WAEC GCE Registration PIN', amount: 24000, quantity_options: [1, 2, 3, 4, 5] },
  { id: 'neco-result', name: 'NECO Result Checking Token', amount: 2100, quantity_options: [1, 2, 3, 4, 5] },
  { id: 'nabteb-result', name: 'NABTEB Result Checking PIN', amount: 1200, quantity_options: [1, 2, 3, 4, 5] },
  { id: 'jamb-utme', name: 'JAMB UTME Registration PIN', amount: 7150, quantity_options: [1], requiresProfileCode: true },
  { id: 'jamb-direct-entry', name: 'JAMB Direct Entry Registration PIN', amount: 5650, quantity_options: [1], requiresProfileCode: true },
];

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
      units: data.units,
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
  if (cached?.data?.length) return cached.data;
  return fallbackDataBundles.filter((bundle) => bundle.network === network);
}

async function refreshDataBundles(network: NetworkProvider): Promise<DataBundle[]> {
  const cached = readCache<DataBundle[]>(dataCatalogCacheKey(network));
  if (cached?.data?.length && Date.now() - cached.savedAt < 5 * 60 * 1000) return cached.data;
  try {
    const { data, error } = await withTimeout(
      supabase.functions.invoke('vtunaija-data-catalog', { body: { network } }),
      12_000,
    );
    if (error || !data?.success || !Array.isArray(data.plans) || data.plans.length === 0) {
      return cachedDataBundles(network);
    }
    const plans = data.plans.filter((plan: DataBundle) =>
      plan?.network === network && typeof plan.id === 'string' && typeof plan.name === 'string' &&
      Number.isFinite(plan.amount) && plan.amount > 0
    ) as DataBundle[];
    if (plans.length === 0) return cachedDataBundles(network);
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
   * Ask the server to verify a single pending order with VTUAfrica right now
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

  getDataBundles(network: NetworkProvider): DataBundle[] {
    return cachedDataBundles(network);
  },

  refreshDataBundles(network: NetworkProvider): Promise<DataBundle[]> {
    return refreshDataBundles(network);
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
    return electricityProviders;
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
    return examTypes;
  },

  buyAirtime(phone: string, network: NetworkProvider, amount: number, authToken: string, idempotencyKey?: string): Promise<VTUResult> {
    // amount is naira from the UI; the server ledger works in kobo.
    return purchase({ service: 'airtime', phone, network, amount: nairaToKobo(amount) }, authToken, idempotencyKey);
  },

  buyData(phone: string, network: NetworkProvider, bundle: DataBundle, authToken: string, idempotencyKey?: string): Promise<VTUResult> {
    return purchase({
      service: 'data',
      phone,
      network,
      bundle_id: bundle.id,
      quoted_amount_kobo: nairaToKobo(bundle.amount),
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
  ): Promise<BatchResultItem[]> {
    const results: BatchResultItem[] = [];
    for (let i = 0; i < recipients.length; i++) {
      const r = recipients[i];
      const res = await vtuService.buyData(r.phone, r.network, r.bundle, authToken);
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
  ): Promise<VTUResult & { token?: string; units?: string }> {
    return purchase({
      service: 'electricity',
      provider_id: providerId,
      meter_number: meterNumber,
      amount: nairaToKobo(amount),
      type,
    }, authToken, idempotencyKey);
  },

  buyTVSubscription(
    providerId: string,
    smartcardNumber: string,
    bouquetId: string,
    _amount: number,
    authToken: string,
    idempotencyKey?: string,
  ): Promise<VTUResult> {
    // Price is resolved server-side from bouquetId; client amount is ignored.
    return purchase({
      service: 'tv',
      provider_id: providerId,
      smartcard_number: smartcardNumber,
      bouquet_id: bouquetId,
    }, authToken, idempotencyKey);
  },

  buyExamPin(
    examType: ExamType,
    quantity: number,
    authToken: string,
    profileCode?: string,
    idempotencyKey?: string,
  ): Promise<VTUResult & { pins?: string[] }> {
    return purchase({
      service: 'exam_pin',
      exam_id: examType.id,
      quantity,
      ...(profileCode ? { profile_code: profileCode } : {}),
    }, authToken, idempotencyKey);
  },
};
