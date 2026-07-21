import { adminClient } from "./auth.ts";

// Airalo Partner API — OAuth2 client_credentials. Token is valid ~24h and
// rate-limited to 3 requests/minute to fetch, so it's cached (same pattern
// as VTU.ng's JWT cache) rather than fetched per-request.
//
// Airalo uses ONE base URL for both sandbox and production — there is no
// separate sandbox host (confirmed at developers.partners.airalo.com). Which
// mode you get is decided entirely by the CREDENTIALS configured: sandbox
// client_id/secret => sandbox mode (test eSIMs, no real charge); production
// client_id/secret => real orders. So "going live" is purely swapping
// AIRALO_CLIENT_ID/SECRET to the production pair — no code or URL change, and
// there is no AIRALO_ENV switch.
const AIRALO_BASE_URL = "https://partners-api.airalo.com";
const AIRALO_CLIENT_ID = Deno.env.get("AIRALO_CLIENT_ID");
const AIRALO_CLIENT_SECRET = Deno.env.get("AIRALO_CLIENT_SECRET");

export class AiraloAuthError extends Error {}

export function isAiraloConfigured(): boolean {
  return !!AIRALO_CLIENT_ID && !!AIRALO_CLIENT_SECRET;
}

async function fetchFreshToken(): Promise<string> {
  const res = await fetch(`${AIRALO_BASE_URL}/v2/token`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: AIRALO_CLIENT_ID || "",
      client_secret: AIRALO_CLIENT_SECRET || "",
      grant_type: "client_credentials",
    }),
  });
  const data = await res.json();
  if (!data?.data?.access_token) {
    throw new AiraloAuthError(data?.meta?.message || "Airalo authentication failed");
  }
  return data.data.access_token as string;
}

/** Shared, cached token — see the comment on AIRALO_BASE_URL above for why. */
export async function getAiraloToken(supabase: ReturnType<typeof adminClient>, forceRefresh = false): Promise<string> {
  if (!forceRefresh) {
    const { data } = await supabase
      .from("airalo_auth")
      .select("token, expires_at")
      .eq("id", 1)
      .maybeSingle();
    if (data?.token && new Date(data.expires_at) > new Date(Date.now() + 60 * 60 * 1000)) {
      return data.token as string;
    }
  }
  const token = await fetchFreshToken();
  // Refresh a bit before the real ~24h expiry to stay safely ahead of it.
  const expiresAt = new Date(Date.now() + 20 * 60 * 60 * 1000).toISOString();
  await supabase.from("airalo_auth").upsert({ id: 1, token, expires_at: expiresAt });
  return token;
}

async function authedFetch(
  supabase: ReturnType<typeof adminClient>,
  path: string,
  init: RequestInit,
): Promise<any> {
  const doCall = async (token: string) => {
    const res = await fetch(`${AIRALO_BASE_URL}${path}`, {
      ...init,
      headers: { ...init.headers, Accept: "application/json", Authorization: `Bearer ${token}` },
    });
    return { status: res.status, data: await res.json() };
  };

  let token = await getAiraloToken(supabase);
  let result = await doCall(token);

  if (result.status === 401) {
    token = await getAiraloToken(supabase, true);
    result = await doCall(token);
  }

  return result.data;
}

/** GET /v2/packages?filter[country]=US — live catalog, prices in USD.
 * `limit=1000` per Airalo's docs so a country's plans can't be truncated by
 * the endpoint's default pagination. */
export async function browseAiraloPackages(
  supabase: ReturnType<typeof adminClient>,
  countryCode: string,
): Promise<any> {
  const query = new URLSearchParams({
    "filter[country]": countryCode,
    "filter[type]": "local",
    limit: "1000",
  });
  return authedFetch(supabase, `/v2/packages?${query.toString()}`, { method: "GET" });
}

/** GET /v2/packages filtered by type only. With NO limit param Airalo returns
 * the FULL catalogue for that type in a single response (per their docs):
 * `local` = every single-country package (used to list all countries),
 * `global` = every regional + worldwide package (used to list regions and to
 * browse a region's plans). */
export async function fetchAiraloCatalog(
  supabase: ReturnType<typeof adminClient>,
  type: "local" | "global",
): Promise<any> {
  // A high `limit` returns the whole catalogue on page 1 (the endpoint
  // otherwise paginates ~25 countries/page — the docs' "no limit = full
  // response" claim is wrong in practice). limit caps PACKAGES, and the full
  // local catalogue is ~3,200 packages, so 20000 comfortably covers it.
  const query = new URLSearchParams({ "filter[type]": type, limit: "20000" });
  return authedFetch(supabase, `/v2/packages?${query.toString()}`, { method: "GET" });
}

/**
 * POST /v2/orders — synchronous: the eSIM's QR code/activation details come
 * back in this same response (no separate async order + query step).
 *
 * Airalo documents this endpoint as multipart/form-data (NOT JSON), with
 * fields as strings — sending a JSON body makes the server treat quantity/
 * package_id as missing and reject the order (422). We build a FormData and
 * deliberately let fetch set the Content-Type (with its multipart boundary)
 * itself rather than forcing a header.
 *
 * There is no idempotency key on Airalo's order endpoint — a retried request
 * creates a genuinely new order. We pass our own idempotency key through
 * `description` purely so a duplicate can be spotted by a human later; it
 * does not prevent double-ordering, so the caller must not retry a timed-out
 * request blindly.
 */
export async function submitAiraloOrder(
  supabase: ReturnType<typeof adminClient>,
  packageId: string,
  quantity: number,
  description: string,
): Promise<any> {
  const form = new FormData();
  form.append("quantity", String(quantity));
  form.append("package_id", packageId);
  form.append("description", description);
  return authedFetch(supabase, "/v2/orders", { method: "POST", body: form });
}

/**
 * GET /v2/balance — the partner's available postpaid credit. Airalo bills
 * postpaid up to a fixed credit limit; when the available balance hits 0, new
 * orders fail, so this powers a low-credit alert. Returns the available amount
 * in USD, or null if it can't be read.
 */
export async function getAiraloBalance(
  supabase: ReturnType<typeof adminClient>,
): Promise<{ available: number; currency: string } | null> {
  const data = await authedFetch(supabase, "/v2/balance", { method: "GET" });
  const bal = data?.data?.balances?.availableBalance;
  const available = Number(bal?.amount);
  if (!Number.isFinite(available)) return null;
  return { available, currency: String(bal?.currency ?? "USD") };
}
