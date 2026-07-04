import { Colors } from '../constants/colors';

// Nigerian mobile network detection + number normalization.
// Used by the contacts feature (and anywhere we ingest numbers in mixed
// formats: +234…, 234…, 0…, with spaces/dashes). Produces a canonical
// 0XXXXXXXXXX form so detection and the VTU server (which expects 0XXXXXXXXXX)
// always agree.

export type NgNetwork = 'mtn' | 'airtel' | 'glo' | '9mobile';

const PREFIXES: Record<NgNetwork, string[]> = {
  mtn: ['0703', '0706', '0803', '0806', '0810', '0813', '0814', '0816', '0903', '0906', '0913', '0916'],
  airtel: ['0701', '0708', '0802', '0808', '0812', '0902', '0907', '0912'],
  glo: ['0705', '0805', '0807', '0811', '0815', '0905', '0915'],
  '9mobile': ['0809', '0817', '0818', '0908', '0909'],
};

export const NETWORK_LABEL: Record<NgNetwork, string> = {
  mtn: 'MTN',
  airtel: 'Airtel',
  glo: 'Glo',
  '9mobile': '9mobile',
};

export const NETWORK_COLOR: Record<NgNetwork, string> = {
  mtn: Colors.MTN,
  airtel: Colors.AIRTEL,
  glo: Colors.GLO,
  '9mobile': Colors.MOBILE,
};

/**
 * Normalize any Nigerian number format to canonical `0XXXXXXXXXX` (11 digits),
 * or null if it can't be a valid NG mobile number.
 *   +234 803 123 4567  -> 08031234567
 *   2348031234567      -> 08031234567
 *   8031234567         -> 08031234567
 *   0803-123-4567      -> 08031234567
 */
export function normalizeNgPhone(raw: string): string | null {
  if (!raw) return null;
  let d = raw.replace(/\D/g, '');
  if (d.startsWith('234')) d = d.slice(3); // strip country code
  if (d.length === 10) d = '0' + d; // missing leading 0
  if (d.length === 11 && d.startsWith('0')) return d;
  return null;
}

/** Detect the carrier from any number format, or null if unknown/invalid. */
export function detectNgNetwork(raw: string): NgNetwork | null {
  const d = normalizeNgPhone(raw);
  if (!d) return null;
  const prefix = d.slice(0, 4);
  for (const net of Object.keys(PREFIXES) as NgNetwork[]) {
    if (PREFIXES[net].includes(prefix)) return net;
  }
  return null;
}

/** A number we can actually route (normalizes + maps to a known carrier). */
export function isValidNgNumber(raw: string): boolean {
  return detectNgNetwork(raw) !== null;
}
