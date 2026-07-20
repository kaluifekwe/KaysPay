// Prembly Identitypass — NIN verification. Used for both the "Verify NIN"
// feature (compare returned record against user-submitted claims, done by
// us) and to source the data rendered on the printable slip/card, since
// Prembly only returns JSON, never an image/PDF.
//
// Confirmed 2026-07-05 directly against Prembly's current live API
// reference: only "x-api-key" is required (the account's Secret Key — the
// Public Key is unused here, and there is no separate app-id). Same base
// URL for sandbox and live; only the key value differs.
const PREMBLY_API_KEY = Deno.env.get("PREMBLY_API_KEY");
const PREMBLY_BASE_URL = "https://api.prembly.com";

export class PremblyError extends Error {}

export function isPremblyConfigured(): boolean {
  return !!PREMBLY_API_KEY;
}

export async function verifyNin(nin: string): Promise<{ status: number; data: any }> {
  if (!PREMBLY_API_KEY) throw new PremblyError("Prembly API key not configured");

  const res = await fetch(`${PREMBLY_BASE_URL}/verification/vnin`, {
    method: "POST",
    headers: {
      "x-api-key": PREMBLY_API_KEY,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ number_nin: nin }),
  });
  return { status: res.status, data: await res.json() };
}

// BVN verification — confirmed against Prembly's own docs (2026-07-05):
// POST /verification/bvn_validation, body { number }, response record at
// data.data with camelCase fields (firstName/middleName/lastName/
// dateOfBirth/phoneNumber) — different casing/shape than the NIN endpoint.
export async function verifyBvn(bvn: string): Promise<{ status: number; data: any }> {
  if (!PREMBLY_API_KEY) throw new PremblyError("Prembly API key not configured");

  const res = await fetch(`${PREMBLY_BASE_URL}/verification/bvn_validation`, {
    method: "POST",
    headers: {
      "x-api-key": PREMBLY_API_KEY,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ number: bvn }),
  });
  return { status: res.status, data: await res.json() };
}
