// Foreign Number (temporary SMS verification numbers) — routed through
// SMSPVA, which offers REAL-SIM numbers that pass carrier checks and actually
// deliver OTPs for the strict services (WhatsApp/Telegram/Google) that block
// the cheap VoIP numbers GrizzlySMS uses. Confirmed live 2026-07-28:
//  - service opt-codes + USD prices from SMSPVA get_prices (US real-SIM pool)
//  - country 2-letter codes validated against SMSPVA get_count_new
//  - get_price returns real carriers (Verizon_US/ATT_US/TMob_US) = real SIM.

export interface ForeignNumberService {
  id: string; // SMSPVA service opt-code
  name: string;
}

// Curated popular services (opt-codes confirmed against SMSPVA's own price
// list). "opt19" is SMSPVA's catch-all "OTHER" (no delivery guarantee).
export const FOREIGN_NUMBER_SERVICES: ForeignNumberService[] = [
  { id: "opt20", name: "WhatsApp" },
  { id: "opt29", name: "Telegram" },
  { id: "opt1", name: "Google / Gmail / YouTube" },
  { id: "opt2", name: "Facebook" },
  { id: "opt16", name: "Instagram + Threads" },
  { id: "opt41", name: "X (Twitter)" },
  { id: "opt104", name: "TikTok" },
  { id: "opt45", name: "Discord" },
  { id: "opt131", name: "Apple / iCloud" },
  { id: "opt15", name: "Microsoft / Outlook" },
  { id: "opt83", name: "PayPal / eBay" },
  { id: "opt44", name: "Amazon" },
  { id: "opt72", name: "Uber" },
  { id: "opt90", name: "Snapchat" },
  { id: "opt9", name: "Tinder" },
  { id: "opt46", name: "Airbnb" },
  { id: "opt101", name: "Netflix" },
  { id: "opt58", name: "Steam" },
  { id: "opt8", name: "LinkedIn" },
  { id: "opt11", name: "Viber" },
  { id: "opt127", name: "Signal" },
  { id: "opt112", name: "Coinbase" },
  { id: "opt65", name: "Yahoo" },
  { id: "opt132", name: "OpenAI / ChatGPT" },
  { id: "opt19", name: "Any other service" },
];

export interface ForeignNumberCountry {
  id: string; // SMSPVA 2-letter country code
  name: string;
}

// Country codes validated live against SMSPVA get_prices (2026-07-28) — every
// code here resolves to a real SMSPVA country. Live per-service availability +
// the price cap are still applied at request time, so what a user actually
// sees for a given service is (this list) ∩ (in stock now) ∩ (under the cap).
export const FOREIGN_NUMBER_COUNTRIES: ForeignNumberCountry[] = [
  // Americas
  { id: "US", name: "United States" },
  { id: "CA", name: "Canada" },
  { id: "MX", name: "Mexico" },
  { id: "BR", name: "Brazil" },
  { id: "AR", name: "Argentina" },
  { id: "CO", name: "Colombia" },
  { id: "CL", name: "Chile" },
  // Europe
  { id: "UK", name: "United Kingdom" },
  { id: "DE", name: "Germany" },
  { id: "FR", name: "France" },
  { id: "ES", name: "Spain" },
  { id: "IT", name: "Italy" },
  { id: "NL", name: "Netherlands" },
  { id: "PL", name: "Poland" },
  { id: "SE", name: "Sweden" },
  { id: "PT", name: "Portugal" },
  { id: "IE", name: "Ireland" },
  { id: "FI", name: "Finland" },
  { id: "CH", name: "Switzerland" },
  { id: "AT", name: "Austria" },
  { id: "BE", name: "Belgium" },
  { id: "CZ", name: "Czech Republic" },
  { id: "GR", name: "Greece" },
  { id: "RO", name: "Romania" },
  { id: "HU", name: "Hungary" },
  { id: "HR", name: "Croatia" },
  { id: "UA", name: "Ukraine" },
  // Asia
  { id: "ID", name: "Indonesia" },
  { id: "PH", name: "Philippines" },
  { id: "MY", name: "Malaysia" },
  { id: "TH", name: "Thailand" },
  { id: "VN", name: "Vietnam" },
  { id: "IN", name: "India" },
  { id: "HK", name: "Hong Kong" },
  { id: "JP", name: "Japan" },
  { id: "KR", name: "South Korea" },
  { id: "SG", name: "Singapore" },
  // Africa
  { id: "ZA", name: "South Africa" },
  { id: "KE", name: "Kenya" },
  { id: "NG", name: "Nigeria" },
  { id: "GH", name: "Ghana" },
  { id: "EG", name: "Egypt" },
  { id: "MA", name: "Morocco" },
  // Middle East
  { id: "IL", name: "Israel" },
  { id: "SA", name: "Saudi Arabia" },
  { id: "TR", name: "Turkey" },
].sort((a, b) => a.name.localeCompare(b.name));

// Retail conversion: SMSPVA cost is in USD. Real-SIM numbers cost more than
// VoIP (e.g. WhatsApp US = $3.50), so retail lands higher — that's the price
// of numbers that actually work. Owner-tunable rate + margin.
export const USD_TO_NGN_RATE = 1400;
export const FOREIGN_NUMBER_MARGIN_PERCENT = 20;

// Hide combinations whose retail exceeds this — SMSPVA real-SIM prices spike
// wildly for some countries (Canada ₦38k, Italy ₦28k) which look absurd to a
// user. We only surface sensibly-priced numbers; the rest are filtered out.
export const MAX_RETAIL_KOBO = 2_000_000; // ₦20,000

export function usdToNgnKobo(usd: number): number {
  return Math.round(usd * USD_TO_NGN_RATE * (1 + FOREIGN_NUMBER_MARGIN_PERCENT / 100) * 100);
}

/** True if this USD cost converts to a retail price within our cap. */
export function isWithinPriceCap(usd: number): boolean {
  return usdToNgnKobo(usd) <= MAX_RETAIL_KOBO;
}

export function isValidServiceCode(code: string): boolean {
  return FOREIGN_NUMBER_SERVICES.some((s) => s.id === code);
}

// SMSPVA service codes are "opt" + digits. An unknown code just returns no
// price / no number and the purchase refunds, so a format check is enough.
export function isPlausibleServiceCode(code: string): boolean {
  return /^opt\d{1,4}$/.test(code);
}

// SMSPVA country codes are 2–3 uppercase letters (US, UK, DE...).
export function isPlausibleCountryCode(code: string): boolean {
  return /^[A-Za-z]{2,3}$/.test(code);
}
