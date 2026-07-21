import { supabase } from '../lib/supabase';
import { koboToNaira } from '../utils/formatCurrency';
import { withTimeout, invokeWithRetry } from '../utils/network';

export interface EsimCountry {
  code: string; // ISO alpha-2
  flag: string;
  name: string;
  fromKobo: number | null; // cheapest plan price (live), null if unknown
}

// An eSIM the customer has already purchased — powers the "My eSIMs" list.
export interface MyEsim {
  id: string;
  countryCode: string; // ISO code (or region slug for legacy regional buys)
  iccid: string | null;
  qrcodeUrl: string | null;
  appleInstallUrl: string | null;
  amountKobo: number;
  purchasedAt: string;
}

// Flag emoji is derived from the ISO code itself (regional indicator
// symbols), rather than hand-listing 150+ flags one by one.
export function flagFromCode(code: string): string {
  return code
    .toUpperCase()
    .split('')
    .map((c) => String.fromCodePoint(0x1f1e6 + (c.charCodeAt(0) - 65)))
    .join('');
}

export interface EsimPlan {
  id: string; // opaque, echo back to purchase
  name: string;
  dataMB: number | null; // null = unlimited
  days: number;
  priceKobo: number;
}

export interface EsimPurchaseResult {
  success: boolean;
  error?: string;
  pending?: boolean;
  message?: string;
  iccid?: string;
  qrcode?: string;
  qrcode_url?: string;
  direct_apple_installation_url?: string;
}

function newIdempotencyKey(): string {
  return `esim_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export const esimService = {
  // The full, LIVE country list from the provider, each stamped with a "from"
  // price. Throws on failure so the caching layer (useCachedData) keeps the
  // last-known-good list on screen instead of going blank — there is no
  // hardcoded list; what shows is exactly what Airalo currently offers.
  async loadCountries(): Promise<EsimCountry[]> {
    const { data, error } = await withTimeout(
      supabase.functions.invoke('esim-catalog', { body: {} }),
    );
    if (error || !data?.success || !Array.isArray(data.countries)) {
      throw new Error('Could not load destinations');
    }
    return data.countries.map((c: any) => ({
      code: String(c.code),
      name: String(c.name),
      flag: flagFromCode(String(c.code)),
      fromKobo: typeof c.from_kobo === 'number' ? c.from_kobo : null,
    }));
  },

  // The customer's purchased eSIMs — completed eSIM transactions that carry a
  // QR — so a QR is retrievable any time from the "My eSIMs" section.
  async getMyEsims(): Promise<MyEsim[]> {
    const { data, error } = await withTimeout(
      (async () =>
        await supabase
          .from('transactions')
          .select('id, amount_ngn, created_at, metadata')
          .eq('type', 'esim')
          .eq('status', 'completed')
          .order('created_at', { ascending: false })
          .limit(50))(),
    );
    if (error) throw new Error((error as any).message || 'Could not load your eSIMs');
    return (data || [])
      .filter((t: any) => t?.metadata?.qrcode_url)
      .map((t: any) => ({
        id: String(t.id),
        countryCode: String(t.metadata?.country || ''),
        iccid: t.metadata?.iccid ?? null,
        qrcodeUrl: t.metadata?.qrcode_url ?? null,
        appleInstallUrl: t.metadata?.apple_install_url ?? null,
        amountKobo: Number(t.amount_ngn) || 0,
        purchasedAt: String(t.created_at),
      }));
  },

  async browsePlans(scope: { country?: string; region?: string }): Promise<{ success: boolean; plans: EsimPlan[]; error?: string }> {
    try {
      const { data, error } = await withTimeout(
        supabase.functions.invoke('esim-browse', {
          body: scope,
        }),
      );
      if (error) {
        let msg = 'Could not load plans. Please try again.';
        try {
          const errBody = await (error as any)?.context?.json?.();
          if (errBody?.error) msg = errBody.error;
        } catch {}
        return { success: false, plans: [], error: msg };
      }
      if (!data?.success) {
        return { success: false, plans: [], error: data?.error || 'Could not load plans' };
      }
      const plans: EsimPlan[] = (data.plans || []).map((p: any) => ({
        id: p.id,
        name: p.name,
        dataMB: p.dataMB,
        days: p.days,
        priceKobo: p.priceKobo,
      }));
      return { success: true, plans };
    } catch {
      return { success: false, plans: [], error: 'Network error. Please try again.' };
    }
  },

  async buyPlan(planId: string, scope: { country?: string; region?: string }, authToken: string): Promise<EsimPurchaseResult> {
    try {
      const idempotencyKey = newIdempotencyKey();
      const { data, error } = await invokeWithRetry<any>(
        () =>
          withTimeout(
            supabase.functions.invoke('esim-purchase', {
              body: { plan_id: planId, ...scope, auth_token: authToken, idempotency_key: idempotencyKey },
            }),
          ),
        idempotencyKey,
      );
      if (error) {
        let msg = 'Purchase failed. Please try again.';
        try {
          const errBody = await (error as any)?.context?.json?.();
          if (errBody?.error) msg = errBody.error;
        } catch {}
        return { success: false, error: msg };
      }
      if (!data?.success) {
        return { success: false, error: data?.error || 'Purchase failed' };
      }
      return {
        success: true,
        pending: data.pending,
        message: data.message,
        iccid: data.iccid,
        qrcode: data.qrcode,
        qrcode_url: data.qrcode_url,
        direct_apple_installation_url: data.direct_apple_installation_url,
      };
    } catch {
      return { success: false, error: 'Network error. Please try again.' };
    }
  },

  formatDataAmount(dataMB: number | null): string {
    if (dataMB === null) return 'Unlimited';
    if (dataMB >= 1024) return `${(dataMB / 1024).toFixed(dataMB % 1024 === 0 ? 0 : 1)}GB`;
    return `${Math.round(dataMB)}MB`;
  },

  koboToNaira,
};
