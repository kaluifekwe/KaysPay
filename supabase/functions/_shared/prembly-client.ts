// Prembly Identitypass — NIN verification. Used for both the "Verify NIN"
// feature (compare returned record against user-submitted claims, done by
// us) and to source the data rendered on the printable slip/card, since
// Prembly only returns JSON, never an image/PDF.
//
// Confirmed 2026-07-05 directly against Prembly's current live API
// reference: only "x-api-key" is required (the account's Secret Key — the
// Public Key is unused here, and there is no separate app-id). Same base
// URL for sandbox and live; only the key value differs.
import { fetchWithTimeout } from "./provider-fetch.ts";

const PREMBLY_API_KEY = Deno.env.get("PREMBLY_API_KEY");
const PREMBLY_APP_ID = Deno.env.get("PREMBLY_APP_ID");
const PREMBLY_BASE_URL = "https://api.prembly.com";

export class PremblyError extends Error {}

export function isPremblyConfigured(): boolean {
  return !!PREMBLY_API_KEY;
}

export async function verifyNin(nin: string): Promise<{ status: number; data: any }> {
  if (!PREMBLY_API_KEY) throw new PremblyError("Prembly API key not configured");

  const res = await fetchWithTimeout(`${PREMBLY_BASE_URL}/verification/vnin`, {
    method: "POST",
    headers: {
      "x-api-key": PREMBLY_API_KEY,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ number_nin: nin }),
  }, 25_000);
  return { status: res.status, data: await res.json() };
}

// BVN verification — confirmed against Prembly's own docs (2026-07-05):
// POST /verification/bvn_validation, body { number }, response record at
// data.data with camelCase fields (firstName/middleName/lastName/
// dateOfBirth/phoneNumber) — different casing/shape than the NIN endpoint.
export async function verifyBvn(bvn: string): Promise<{ status: number; data: any }> {
  if (!PREMBLY_API_KEY) throw new PremblyError("Prembly API key not configured");

  const res = await fetchWithTimeout(`${PREMBLY_BASE_URL}/verification/bvn_validation`, {
    method: "POST",
    headers: {
      "x-api-key": PREMBLY_API_KEY,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ number: bvn }),
  }, 25_000);
  return { status: res.status, data: await res.json() };
}

// BVN Advance — the full NIBSS record: enrollment bank + branch, LGA of origin
// + residence, state of origin + residence, residential address, gender,
// marital status, nationality, name on card, watchlist status, and the base64
// photo. This is what a complete printable BVN slip needs, and it's the
// premium product (costs more per call than bvn_validation), so it's used only
// for the paid slip/card flow. Same base + Secret-Key-only auth as the other
// endpoints on this account (no app-id) — an optional app-id header is still
// sent if PREMBLY_APP_ID is ever configured, for accounts that require it.
export async function verifyBvnFull(bvn: string): Promise<{ status: number; data: any }> {
  if (!PREMBLY_API_KEY) throw new PremblyError("Prembly API key not configured");

  const headers: Record<string, string> = {
    "x-api-key": PREMBLY_API_KEY,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (PREMBLY_APP_ID) headers["app-id"] = PREMBLY_APP_ID;

  const res = await fetchWithTimeout(`${PREMBLY_BASE_URL}/verification/bvn`, {
    method: "POST",
    headers,
    body: JSON.stringify({ number: bvn }),
  }, 25_000);
  return { status: res.status, data: await res.json() };
}
