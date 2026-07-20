import { adminClient } from "./auth.ts";

// Flutterwave v4 API — OAuth2 client-credentials auth (NOT a static secret
// key like Paystack/v3). Tokens expire in 600s (10 min), so unlike VTU.ng's
// ~7-day token this needs a much tighter cache/refresh window. See migration
// 023 for the flutterwave_auth cache table (same single-row pattern as
// vtu_ng_auth). Server-only — never exposed to the client.
const FLW_TOKEN_URL = "https://idp.flutterwave.com/realms/flutterwave/protocol/openid-connect/token";
const FLW_BASE_URL = Deno.env.get("FLUTTERWAVE_ENV") === "live"
  ? "https://f4bexperience.flutterwave.com"
  : "https://developersandbox-api.flutterwave.com";

const FLW_CLIENT_ID = Deno.env.get("FLUTTERWAVE_CLIENT_ID");
const FLW_CLIENT_SECRET = Deno.env.get("FLUTTERWAVE_CLIENT_SECRET");

export class FlutterwaveAuthError extends Error {}

export function isFlutterwaveConfigured(): boolean {
  return !!FLW_CLIENT_ID && !!FLW_CLIENT_SECRET;
}

async function fetchFreshToken(): Promise<string> {
  const res = await fetch(FLW_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: FLW_CLIENT_ID ?? "",
      client_secret: FLW_CLIENT_SECRET ?? "",
      grant_type: "client_credentials",
    }),
  });
  const data = await res.json();
  if (!data?.access_token) {
    throw new FlutterwaveAuthError(data?.error_description || data?.error || "Flutterwave authentication failed");
  }
  return data.access_token as string;
}

/** Shared, cached token — refreshed well before the real 600s expiry. */
export async function getToken(supabase: ReturnType<typeof adminClient>, forceRefresh = false): Promise<string> {
  if (!forceRefresh) {
    const { data } = await supabase
      .from("flutterwave_auth")
      .select("token, expires_at")
      .eq("id", 1)
      .maybeSingle();
    if (data?.token && new Date(data.expires_at) > new Date(Date.now() + 90 * 1000)) {
      return data.token as string;
    }
  }
  const token = await fetchFreshToken();
  // Real expiry is 600s — refresh with a comfortable safety margin.
  const expiresAt = new Date(Date.now() + 480 * 1000).toISOString();
  await supabase.from("flutterwave_auth").upsert({ id: 1, token, expires_at: expiresAt });
  return token;
}

/**
 * Calls a Flutterwave v4 endpoint with the cached token, retrying once with
 * a freshly-fetched token on a 401 (covers both a stale cache entry and the
 * short-lived-token race — same self-healing pattern as callVTUNG).
 */
export async function callFlutterwave(
  supabase: ReturnType<typeof adminClient>,
  path: string,
  method: string,
  body?: Record<string, unknown>,
  idempotencyKey?: string,
): Promise<{ status: number; data: any }> {
  const doCall = async (token: string) => {
    const res = await fetch(`${FLW_BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(idempotencyKey ? { "X-Idempotency-Key": idempotencyKey } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json() };
  };

  let token = await getToken(supabase);
  let result = await doCall(token);

  if (result.status === 401) {
    token = await getToken(supabase, true);
    result = await doCall(token);
  }

  return result;
}

export function createCustomer(
  supabase: ReturnType<typeof adminClient>,
  params: { firstName: string; lastName: string; email: string },
  idempotencyKey: string,
) {
  return callFlutterwave(supabase, "/customers", "POST", {
    name: { first: params.firstName, last: params.lastName },
    email: params.email,
  }, idempotencyKey);
}

export function createStaticVirtualAccount(
  supabase: ReturnType<typeof adminClient>,
  params: { customerId: string; reference: string; narration: string; bvnOrNin: string },
  idempotencyKey: string,
) {
  return callFlutterwave(supabase, "/virtual-accounts", "POST", {
    reference: params.reference,
    customer_id: params.customerId,
    amount: 0,
    currency: "NGN",
    account_type: "static",
    narration: params.narration,
    bvn: params.bvnOrNin,
    // Testing whether ANY bank_code is honored for real BVN-verified
    // accounts (035/Wema was silently overridden to Indulge on the last
    // live attempt) — trying Access Bank next as a second data point.
    bank_code: "044",
  }, idempotencyKey);
}
