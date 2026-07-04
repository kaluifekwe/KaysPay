import { supabase } from '../lib/supabase';
import { koboToNaira } from '../utils/formatCurrency';

export interface EsimCountry {
  code: string; // ISO alpha-2
  flag: string;
  name: string;
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

// Both eSIM Access and Airalo cover 100+ countries each — this is a broad
// ISO 3166-1 list (not exhaustive of every micro-territory) rather than a
// small curated subset, since narrowing it down further would just hide
// destinations customers actually want.
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

  async browsePlans(countryCode: string): Promise<{ success: boolean; plans: EsimPlan[]; error?: string }> {
    try {
      const { data, error } = await supabase.functions.invoke('esim-browse', {
        body: { country: countryCode },
      });
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

  async buyPlan(planId: string, countryCode: string, authToken: string): Promise<EsimPurchaseResult> {
    try {
      const { data, error } = await supabase.functions.invoke('esim-purchase', {
        body: { plan_id: planId, country: countryCode, auth_token: authToken, idempotency_key: newIdempotencyKey() },
      });
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
