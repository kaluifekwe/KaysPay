import { supabase } from '../lib/supabase';

export interface ForeignNumberService {
  id: string;
  name: string;
}

export interface ForeignNumberCountry {
  id: string;
  name: string;
}

// Confirmed against GrizzlySMS's own getServicesList API response
// (2026-07-02) — matches _shared/foreign-number-catalog.ts on the server exactly.
export const FOREIGN_NUMBER_SERVICES: ForeignNumberService[] = [
  { id: 'wa', name: 'WhatsApp' },
  { id: 'tg', name: 'Telegram' },
  { id: 'go', name: 'Google / Gmail / YouTube' },
  { id: 'fb', name: 'Facebook' },
  { id: 'ig', name: 'Instagram + Threads' },
  { id: 'ts', name: 'PayPal' },
  { id: 'wx', name: 'Apple / iCloud' },
  { id: 'nf', name: 'Netflix' },
  { id: 'lf', name: 'TikTok' },
  { id: 'fu', name: 'Snapchat' },
  { id: 'ds', name: 'Discord' },
  { id: 'tw', name: 'Twitter / X' },
  { id: 'ub', name: 'Uber' },
  { id: 'mt', name: 'Steam' },
  { id: 'tn', name: 'LinkedIn' },
  { id: 'gr_sg', name: 'Signal' },
  { id: 'vi', name: 'Viber' },
  { id: 'am', name: 'Amazon' },
  { id: 'dh', name: 'eBay' },
  { id: 'sf', name: 'Spotify' },
  { id: 'mm', name: 'Microsoft / Outlook' },
  { id: 'me', name: 'Line' },
  { id: 'mo', name: 'Bumble' },
  { id: 're', name: 'Coinbase' },
  { id: 'aon', name: 'Binance' },
  { id: 'uk', name: 'Airbnb' },
  { id: 'mb', name: 'Yahoo' },
  { id: 'pm', name: 'AOL' },
  { id: 'dp', name: 'ProtonMail' },
  { id: 'hb', name: 'Twitch' },
  { id: 'bnl', name: 'Reddit' },
  { id: 'pnts', name: 'Pinterest' },
  { id: 'wb', name: 'WeChat' },
  { id: 'hw', name: 'AliPay' },
  { id: 'jg', name: 'Grab' },
  { id: 'ni', name: 'Gojek' },
  { id: 'ka', name: 'Shopee' },
  { id: 'dl', name: 'Lazada' },
];

export const FOREIGN_NUMBER_COUNTRIES: ForeignNumberCountry[] = [
  { id: '19', name: 'Nigeria' },
  { id: '187', name: 'United States' },
  { id: '12', name: 'United States (Virtual)' },
  { id: '16', name: 'United Kingdom' },
  { id: '36', name: 'Canada' },
  { id: '95', name: 'United Arab Emirates' },
  { id: '38', name: 'Ghana' },
  { id: '8', name: 'Kenya' },
  { id: '31', name: 'South Africa' },
  { id: '1', name: 'Ukraine' },
  { id: '2', name: 'Kazakhstan' },
  { id: '3', name: 'China' },
  { id: '4', name: 'Philippines' },
  { id: '5', name: 'Myanmar' },
  { id: '6', name: 'Indonesia' },
  { id: '7', name: 'Malaysia' },
  { id: '9', name: 'Tanzania' },
  { id: '10', name: 'Vietnam' },
  { id: '11', name: 'Kyrgyzstan' },
  { id: '13', name: 'Israel' },
  { id: '14', name: 'Hong Kong' },
  { id: '15', name: 'Poland' },
  { id: '17', name: 'Madagascar' },
  { id: '18', name: 'DR Congo' },
  { id: '20', name: 'Macao' },
  { id: '21', name: 'Egypt' },
  { id: '22', name: 'India' },
  { id: '23', name: 'Ireland' },
  { id: '24', name: 'Cambodia' },
  { id: '25', name: 'Laos' },
  { id: '26', name: 'Haiti' },
  { id: '27', name: 'Ivory Coast' },
  { id: '28', name: 'Gambia' },
  { id: '29', name: 'Serbia' },
  { id: '30', name: 'Yemen' },
  { id: '32', name: 'Romania' },
  { id: '33', name: 'Colombia' },
  { id: '34', name: 'Estonia' },
  { id: '35', name: 'Azerbaijan' },
  { id: '37', name: 'Morocco' },
  { id: '39', name: 'Argentina' },
  { id: '40', name: 'Uzbekistan' },
  { id: '41', name: 'Cameroon' },
  { id: '42', name: 'Chad' },
  { id: '43', name: 'Germany' },
  { id: '44', name: 'Lithuania' },
  { id: '45', name: 'Croatia' },
  { id: '46', name: 'Sweden' },
  { id: '47', name: 'Iraq' },
  { id: '48', name: 'Netherlands' },
  { id: '49', name: 'Latvia' },
  { id: '50', name: 'Austria' },
  { id: '51', name: 'Belarus' },
  { id: '52', name: 'Thailand' },
  { id: '53', name: 'Saudi Arabia' },
  { id: '54', name: 'Mexico' },
  { id: '55', name: 'Taiwan' },
  { id: '56', name: 'Spain' },
  { id: '58', name: 'Algeria' },
  { id: '59', name: 'Slovenia' },
  { id: '60', name: 'Bangladesh' },
  { id: '61', name: 'Senegal' },
  { id: '62', name: 'Turkey' },
  { id: '63', name: 'Czech Republic' },
  { id: '64', name: 'Sri Lanka' },
  { id: '65', name: 'Peru' },
  { id: '66', name: 'Pakistan' },
  { id: '67', name: 'New Zealand' },
  { id: '68', name: 'Guinea' },
  { id: '69', name: 'Mali' },
  { id: '70', name: 'Venezuela' },
  { id: '71', name: 'Ethiopia' },
  { id: '72', name: 'Mongolia' },
  { id: '73', name: 'Brazil' },
  { id: '74', name: 'Afghanistan' },
  { id: '75', name: 'Uganda' },
  { id: '76', name: 'Angola' },
  { id: '77', name: 'Cyprus' },
  { id: '78', name: 'France' },
  { id: '79', name: 'Papua New Guinea' },
  { id: '80', name: 'Mozambique' },
  { id: '81', name: 'Nepal' },
  { id: '82', name: 'Belgium' },
  { id: '83', name: 'Bulgaria' },
  { id: '84', name: 'Hungary' },
  { id: '85', name: 'Moldova' },
  { id: '86', name: 'Italy' },
  { id: '87', name: 'Paraguay' },
  { id: '88', name: 'Honduras' },
  { id: '89', name: 'Tunisia' },
  { id: '90', name: 'Nicaragua' },
  { id: '91', name: 'Timor-Leste' },
  { id: '92', name: 'Bolivia' },
  { id: '93', name: 'Costa Rica' },
  { id: '94', name: 'Guatemala' },
  { id: '96', name: 'Zimbabwe' },
  { id: '97', name: 'Puerto Rico' },
  { id: '99', name: 'Togo' },
  { id: '100', name: 'Kuwait' },
  { id: '101', name: 'El Salvador' },
  { id: '102', name: 'Libya' },
  { id: '103', name: 'Jamaica' },
  { id: '104', name: 'Trinidad and Tobago' },
  { id: '105', name: 'Ecuador' },
  { id: '106', name: 'Eswatini' },
  { id: '107', name: 'Oman' },
  { id: '108', name: 'Bosnia and Herzegovina' },
  { id: '109', name: 'Dominican Republic' },
  { id: '110', name: 'Syria' },
  { id: '111', name: 'Qatar' },
  { id: '112', name: 'Panama' },
  { id: '113', name: 'Cuba' },
  { id: '114', name: 'Mauritania' },
  { id: '115', name: 'Sierra Leone' },
  { id: '116', name: 'Jordan' },
  { id: '117', name: 'Portugal' },
  { id: '118', name: 'Barbados' },
  { id: '119', name: 'Burundi' },
  { id: '120', name: 'Benin' },
  { id: '121', name: 'Brunei' },
  { id: '122', name: 'Bahamas' },
  { id: '123', name: 'Botswana' },
  { id: '124', name: 'Belize' },
  { id: '125', name: 'Central African Republic' },
  { id: '126', name: 'Dominica' },
  { id: '127', name: 'Grenada' },
  { id: '128', name: 'Georgia' },
  { id: '129', name: 'Greece' },
  { id: '130', name: 'Guinea-Bissau' },
  { id: '131', name: 'Guyana' },
  { id: '132', name: 'Iceland' },
  { id: '133', name: 'Comoros' },
  { id: '134', name: 'Saint Kitts and Nevis' },
  { id: '135', name: 'Liberia' },
  { id: '136', name: 'Lesotho' },
  { id: '137', name: 'Malawi' },
  { id: '138', name: 'Namibia' },
  { id: '139', name: 'Niger' },
  { id: '140', name: 'Rwanda' },
  { id: '141', name: 'Slovakia' },
  { id: '142', name: 'Suriname' },
  { id: '143', name: 'Tajikistan' },
  { id: '144', name: 'Monaco' },
  { id: '145', name: 'Bahrain' },
  { id: '146', name: 'Reunion' },
  { id: '147', name: 'Zambia' },
  { id: '148', name: 'Armenia' },
  { id: '149', name: 'Somalia' },
  { id: '150', name: 'Republic of the Congo' },
  { id: '151', name: 'Chile' },
  { id: '152', name: 'Burkina Faso' },
  { id: '153', name: 'Lebanon' },
  { id: '154', name: 'Gabon' },
  { id: '155', name: 'Albania' },
  { id: '156', name: 'Uruguay' },
  { id: '157', name: 'Mauritius' },
  { id: '158', name: 'Bhutan' },
  { id: '159', name: 'Maldives' },
  { id: '160', name: 'Guadeloupe' },
  { id: '161', name: 'Turkmenistan' },
  { id: '162', name: 'French Guiana' },
  { id: '163', name: 'Finland' },
  { id: '164', name: 'Saint Lucia' },
  { id: '165', name: 'Luxembourg' },
  { id: '166', name: 'Saint Vincent' },
  { id: '167', name: 'Equatorial Guinea' },
  { id: '168', name: 'Djibouti' },
  { id: '169', name: 'Antigua and Barbuda' },
  { id: '170', name: 'Cayman Islands' },
  { id: '171', name: 'Montenegro' },
  { id: '172', name: 'Denmark' },
  { id: '173', name: 'Switzerland' },
  { id: '174', name: 'Norway' },
  { id: '175', name: 'Australia' },
  { id: '176', name: 'Eritrea' },
  { id: '177', name: 'South Sudan' },
  { id: '178', name: 'Sao Tome and Principe' },
  { id: '179', name: 'Aruba' },
  { id: '180', name: 'Montserrat' },
  { id: '181', name: 'Anguilla' },
  { id: '182', name: 'Japan' },
  { id: '183', name: 'North Macedonia' },
  { id: '184', name: 'Seychelles' },
  { id: '185', name: 'New Caledonia' },
  { id: '186', name: 'Cape Verde' },
  { id: '188', name: 'Palestine' },
  { id: '189', name: 'Fiji' },
  { id: '199', name: 'Malta' },
  { id: '201', name: 'Gibraltar' },
  { id: '203', name: 'Kosovo' },
  { id: '204', name: 'Niue' },
  { id: '1003', name: 'Bermuda' },
  { id: '1007', name: 'Vanuatu' },
  { id: '1008', name: 'Greenland' },
  { id: '1011', name: 'Martinique' },
  { id: '1012', name: 'French Polynesia' },
  { id: '1062', name: 'Andorra' },
  { id: '10016', name: 'Iran' },
  { id: '10161', name: 'American Samoa' },
  { id: '10227', name: 'Tonga' },
  { id: '10231', name: 'Samoa' },
  { id: '10348', name: 'Liechtenstein' },
  { id: '10349', name: 'Sint Maarten' },
  { id: '10350', name: 'South Korea' },
  { id: '10351', name: 'Singapore' },
].sort((a, b) => a.name.localeCompare(b.name));

export interface ForeignNumberPriceResult {
  success: boolean;
  error?: string;
  priceKobo?: number;
  available?: number;
  service?: string;
  serviceName?: string;
}

export interface ForeignNumberPurchaseResult {
  success: boolean;
  error?: string;
  transaction_id?: string;
  activation_id?: string;
  phone_number?: string;
  service_name?: string;
}

export interface ForeignNumberStatusResult {
  success: boolean;
  error?: string;
  done?: boolean;
  cancelled?: boolean;
  code?: string;
}

export interface ForeignNumberCancelResult {
  success: boolean;
  error?: string;
  refunded?: boolean;
  message?: string;
}

function newIdempotencyKey(): string {
  return `fnum_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

async function extractError(error: unknown, fallback: string): Promise<string> {
  try {
    const errBody = await (error as any)?.context?.json?.();
    if (errBody?.error) return errBody.error;
  } catch {}
  return fallback;
}

export const foreignNumberService = {
  getServices(): ForeignNumberService[] {
    return FOREIGN_NUMBER_SERVICES;
  },

  getCountries(): ForeignNumberCountry[] {
    return FOREIGN_NUMBER_COUNTRIES;
  },

  async getPrice(service: string | null, country: string): Promise<ForeignNumberPriceResult> {
    try {
      const { data, error } = await supabase.functions.invoke('foreign-number-price', {
        body: service ? { service, country } : { country },
      });
      if (error) return { success: false, error: await extractError(error, 'Could not load price.') };
      if (!data?.success) return { success: false, error: data?.error || 'Could not load price' };
      return {
        success: true,
        priceKobo: data.priceKobo,
        available: data.available,
        service: data.service,
        serviceName: data.serviceName,
      };
    } catch {
      return { success: false, error: 'Network error. Please try again.' };
    }
  },

  async purchase(service: string, country: string, authToken: string): Promise<ForeignNumberPurchaseResult> {
    try {
      const { data, error } = await supabase.functions.invoke('foreign-number-purchase', {
        body: { service, country, auth_token: authToken, idempotency_key: newIdempotencyKey() },
      });
      if (error) return { success: false, error: await extractError(error, 'Purchase failed. Please try again.') };
      if (!data?.success) return { success: false, error: data?.error || 'Purchase failed' };
      return {
        success: true,
        transaction_id: data.transaction_id,
        activation_id: data.activation_id,
        phone_number: data.phone_number,
        service_name: data.service_name,
      };
    } catch {
      return { success: false, error: 'Network error. Please try again.' };
    }
  },

  async checkStatus(activationId: string): Promise<ForeignNumberStatusResult> {
    try {
      const { data, error } = await supabase.functions.invoke('foreign-number-status', {
        body: { activation_id: activationId },
      });
      if (error) return { success: false, error: await extractError(error, 'Could not check status.') };
      if (!data?.success) return { success: false, error: data?.error || 'Could not check status' };
      return { success: true, done: data.done, cancelled: data.cancelled, code: data.code };
    } catch {
      return { success: false, error: 'Network error. Please try again.' };
    }
  },

  async cancel(activationId: string): Promise<ForeignNumberCancelResult> {
    try {
      const { data, error } = await supabase.functions.invoke('foreign-number-cancel', {
        body: { activation_id: activationId },
      });
      if (error) return { success: false, error: await extractError(error, 'Could not cancel.') };
      if (!data?.success) return { success: false, error: data?.error || 'Could not cancel' };
      return { success: true, refunded: data.refunded, message: data.message };
    } catch {
      return { success: false, error: 'Network error. Please try again.' };
    }
  },
};
