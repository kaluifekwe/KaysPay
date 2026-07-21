import { supabase } from '../lib/supabase';
import { koboToNaira } from '../utils/formatCurrency';
import { withTimeout, invokeWithRetry } from '../utils/network';

export interface EsimCountry {
  code: string; // ISO alpha-2
  flag: string;
  name: string;
}

export interface EsimRegion {
  slug: string;
  name: string;
  worldwide: boolean;
}

// A pickable eSIM destination — either a single country or a multi-country
// region / worldwide plan. Unified so the UI renders one list.
export interface EsimDestination {
  kind: 'country' | 'region';
  id: string; // ISO code (country) or region slug
  name: string;
  flag: string;
}

// Flag emoji is derived from the ISO code itself (regional indicator
// symbols), rather than hand-listing 150+ flags one by one.
function flagFromCode(code: string): string {
  return code
    .toUpperCase()
    .split('')
    .map((c) => String.fromCodePoint(0x1f1e6 + (c.charCodeAt(0) - 65)))
    .join('');
}

// Airalo covers 100+ countries — this is a broad ISO 3166-1 list (not
// exhaustive of every micro-territory) rather than a small curated subset,
// since narrowing it down further would just hide destinations customers
// actually want.
const COUNTRY_NAMES: [string, string][] = [
  ['US', 'United States'], ['GB', 'United Kingdom'], ['CA', 'Canada'], ['AE', 'United Arab Emirates'],
  ['DE', 'Germany'], ['FR', 'France'], ['IT', 'Italy'], ['ES', 'Spain'], ['TR', 'Turkey'],
  ['ZA', 'South Africa'], ['IN', 'India'], ['CN', 'China'], ['MY', 'Malaysia'], ['SA', 'Saudi Arabia'],
  ['GH', 'Ghana'], ['NL', 'Netherlands'], ['BE', 'Belgium'], ['CH', 'Switzerland'], ['AT', 'Austria'],
  ['PT', 'Portugal'], ['IE', 'Ireland'], ['SE', 'Sweden'], ['NO', 'Norway'], ['DK', 'Denmark'],
  ['FI', 'Finland'], ['PL', 'Poland'], ['CZ', 'Czech Republic'], ['GR', 'Greece'], ['HU', 'Hungary'],
  ['RO', 'Romania'], ['BG', 'Bulgaria'], ['HR', 'Croatia'], ['SI', 'Slovenia'], ['SK', 'Slovakia'],
  ['IS', 'Iceland'], ['LU', 'Luxembourg'], ['MT', 'Malta'], ['CY', 'Cyprus'], ['EE', 'Estonia'],
  ['LV', 'Latvia'], ['LT', 'Lithuania'], ['UA', 'Ukraine'], ['RU', 'Russia'],
  ['QA', 'Qatar'], ['KW', 'Kuwait'], ['BH', 'Bahrain'], ['OM', 'Oman'], ['JO', 'Jordan'],
  ['IL', 'Israel'], ['EG', 'Egypt'], ['MA', 'Morocco'], ['TN', 'Tunisia'], ['DZ', 'Algeria'],
  ['KE', 'Kenya'], ['TZ', 'Tanzania'], ['UG', 'Uganda'], ['RW', 'Rwanda'], ['ET', 'Ethiopia'],
  ['SN', 'Senegal'], ['CI', 'Ivory Coast'], ['CM', 'Cameroon'], ['ZM', 'Zambia'], ['ZW', 'Zimbabwe'],
  ['NA', 'Namibia'], ['BW', 'Botswana'], ['MU', 'Mauritius'],
  ['JP', 'Japan'], ['KR', 'South Korea'], ['SG', 'Singapore'], ['TH', 'Thailand'], ['VN', 'Vietnam'],
  ['ID', 'Indonesia'], ['PH', 'Philippines'], ['HK', 'Hong Kong'], ['TW', 'Taiwan'], ['KH', 'Cambodia'],
  ['LA', 'Laos'], ['MM', 'Myanmar'], ['NP', 'Nepal'], ['LK', 'Sri Lanka'], ['BD', 'Bangladesh'],
  ['PK', 'Pakistan'], ['KZ', 'Kazakhstan'], ['UZ', 'Uzbekistan'], ['MN', 'Mongolia'],
  ['AU', 'Australia'], ['NZ', 'New Zealand'], ['FJ', 'Fiji'],
  ['MX', 'Mexico'], ['BR', 'Brazil'], ['AR', 'Argentina'], ['CL', 'Chile'], ['CO', 'Colombia'],
  ['PE', 'Peru'], ['EC', 'Ecuador'], ['UY', 'Uruguay'], ['PY', 'Paraguay'], ['BO', 'Bolivia'],
  ['CR', 'Costa Rica'], ['PA', 'Panama'], ['DO', 'Dominican Republic'], ['JM', 'Jamaica'],
  ['TT', 'Trinidad and Tobago'], ['BS', 'Bahamas'], ['BB', 'Barbados'],
  ['GE', 'Georgia'], ['AM', 'Armenia'], ['AZ', 'Azerbaijan'], ['AL', 'Albania'], ['RS', 'Serbia'],
  ['BA', 'Bosnia and Herzegovina'], ['MK', 'North Macedonia'], ['ME', 'Montenegro'], ['MD', 'Moldova'],
];

export const ESIM_COUNTRIES: EsimCountry[] = COUNTRY_NAMES.map(([code, name]) => ({
  code,
  name,
  flag: flagFromCode(code),
})).sort((a, b) => a.name.localeCompare(b.name));

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
  getCountries(): EsimCountry[] {
    return ESIM_COUNTRIES;
  },

  // Full, self-updating destination list from the server (every Airalo country
  // + regional/worldwide plans). Falls back to the built-in country list if the
  // catalog can't be reached, so browsing never breaks.
  async loadDestinations(): Promise<EsimDestination[]> {
    try {
      const { data, error } = await withTimeout(
        supabase.functions.invoke('esim-catalog', { body: {} }),
      );
      if (!error && data?.success && Array.isArray(data.countries) && data.countries.length > 0) {
        const regions: EsimDestination[] = (data.regions || []).map((r: any) => ({
          kind: 'region' as const,
          id: String(r.slug),
          name: String(r.name),
          flag: r.worldwide ? '🌍' : '🌐',
        }));
        const countries: EsimDestination[] = data.countries.map((c: any) => ({
          kind: 'country' as const,
          id: String(c.code),
          name: String(c.name),
          flag: flagFromCode(String(c.code)),
        }));
        return [...regions, ...countries];
      }
    } catch {
      // fall through to the built-in list
    }
    return ESIM_COUNTRIES.map((c) => ({ kind: 'country' as const, id: c.code, name: c.name, flag: c.flag }));
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
