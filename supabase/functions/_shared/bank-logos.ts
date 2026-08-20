import { fetchWithTimeout } from "./provider-fetch.ts";

// Public, GitHub-backed logo list served via jsDelivr's CDN — Quidax's own
// bank lists (Exchange and Ramp off-ramp both) carry no logo field at all
// (confirmed against the live response, 2026-08-20), and this is the most
// reliable free source found: stable CDN, static JSON, no auth, no rate
// limit in practice. Codes follow the standard NIBSS/CBN scheme, which
// matches Quidax's own bank codes for the same institutions.
const LOGO_LIST_URL = "https://cdn.jsdelivr.net/gh/jsanwo64/Nigeria-Banks-Logo-API/Banks.json";

// Manual supplement — the primary source above has near-total coverage of
// traditional banks but misses several major fintech ones customers
// actually pick often. Each URL individually verified (real 200, real
// image/png) 2026-08-20 before being added here. PalmPay and Opay are
// deliberately NOT included: no source found stable enough to hotlink long
// term (only third-party "download this logo" sites, not real CDNs) — they
// fall back to the plain initial badge until KaysPay hosts its own copy.
const MANUAL_LOGOS: Record<string, string> = {
  "50211": "https://supermx1.github.io/nigerian-banks-api/logos/kuda-bank.png", // Kuda bank
  "090267": "https://supermx1.github.io/nigerian-banks-api/logos/kuda-bank.png", // Kuda Microfinance Bank (same institution, different Quidax entry)
  "090405": "https://supermx1.github.io/nigerian-banks-api/logos/moniepoint-mfb-ng.png", // Moniepoint Microfinance Bank
  "133": "https://supermx1.github.io/nigerian-banks-api/logos/providus-bank.png", // Providus Bank
};

let cache: Map<string, string> | null = null;
let cacheExpiresAt = 0;

async function loadLogoMap(): Promise<Map<string, string>> {
  if (cache && Date.now() < cacheExpiresAt) return cache;
  try {
    const res = await fetchWithTimeout(LOGO_LIST_URL, {}, 10_000);
    const list = (await res.json()) as { code?: string; logo?: string }[];
    const map = new Map<string, string>();
    for (const entry of list) {
      if (entry.code && entry.logo) map.set(String(entry.code), String(entry.logo));
    }
    for (const [code, logo] of Object.entries(MANUAL_LOGOS)) map.set(code, logo);
    cache = map;
    cacheExpiresAt = Date.now() + 24 * 60 * 60 * 1000; // static list, refetch once a day at most
    return map;
  } catch {
    // A logo is cosmetic — never let this failure block a bank list from
    // loading. Return whatever's cached (possibly empty) rather than throw.
    return cache ?? new Map(Object.entries(MANUAL_LOGOS));
  }
}

/** Attaches a `logo` URL to any bank list whose `code` follows the standard NIBSS/CBN scheme — leaves it undefined when there's no match, never a broken placeholder. */
export async function withBankLogos<T extends { code: string }>(banks: T[]): Promise<(T & { logo?: string })[]> {
  const logos = await loadLogoMap();
  return banks.map((b) => (logos.has(b.code) ? { ...b, logo: logos.get(b.code) } : b));
}
