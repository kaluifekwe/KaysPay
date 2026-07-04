import { adminClient } from "./auth.ts";

// Airalo Partner API — OAuth2 client_credentials. Token is valid ~24h and
// rate-limited to 3 requests/minute to fetch, so it's cached (same pattern
// as VTU.ng's JWT cache) rather than fetched per-request.
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

/** GET /v2/packages?filter[country]=US — live catalog, prices in USD. */
export async function browseAiraloPackages(
  supabase: ReturnType<typeof adminClient>,
  countryCode: string,
): Promise<any> {
  const query = new URLSearchParams({ "filter[country]": countryCode, "filter[type]": "local" });
  return authedFetch(supabase, `/v2/packages?${query.toString()}`, { method: "GET" });
}

/**
 * POST /v2/orders — synchronous: the eSIM's QR code/activation details come
 * back in this same response, unlike eSIM Access's async order+query flow.
 *
 * Unlike eSIM Access's `transactionId`, Airalo's order endpoint has no
 * idempotency key — a retried request creates a genuinely new order. We
 * pass our own idempotency key through `description` purely so a duplicate
 * can be spotted by a human later; it does not prevent double-ordering on
 * our end, so the caller must not retry a timed-out request blindly.
 */
export async function submitAiraloOrder(
  supabase: ReturnType<typeof adminClient>,
  packageId: string,
  quantity: number,
  description: string,
): Promise<any> {
  return authedFetch(supabase, "/v2/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ quantity, package_id: packageId, description }),
  });
}
