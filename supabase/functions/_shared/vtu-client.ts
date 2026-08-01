import { adminClient } from "./auth.ts";
import { fetchWithTimeout } from "./provider-fetch.ts";

// VTU.ng API v2 — the Legacy v1 API this used to call is being discontinued.
// Auth: JWT bearer token (login once, cache, refresh every ~7 days — NOT
// per-request, since "generating a new token invalidates older ones" and
// concurrent requests would knock each other's tokens out). POST + JSON body.
const VTU_NG_AUTH_URL = "https://vtu.ng/wp-json/jwt-auth/v1/token";
const VTU_NG_API_BASE = "https://vtu.ng/wp-json/api/v2";
const VTU_NG_USERNAME = Deno.env.get("VTU_NG_USERNAME");
const VTU_NG_PASSWORD = Deno.env.get("VTU_NG_PASSWORD");

export class VTUAuthError extends Error {}

async function fetchFreshToken(): Promise<string> {
  const res = await fetchWithTimeout(VTU_NG_AUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: VTU_NG_USERNAME, password: VTU_NG_PASSWORD }),
  }, 15_000);
  const data = await res.json();
  if (!data?.token) {
    // Tagged separately from network/provider errors so the real cause
    // (bad credentials) isn't mislabeled as "network error" to the user.
    throw new VTUAuthError(data?.message?.replace(/<[^>]+>/g, "") || "VTU.ng authentication failed");
  }
  return data.token as string;
}

/** Shared, cached token — see the comment on VTU_NG_AUTH_URL above for why. */
export async function getToken(supabase: ReturnType<typeof adminClient>, forceRefresh = false): Promise<string> {
  if (!forceRefresh) {
    const { data } = await supabase
      .from("vtu_ng_auth")
      .select("token, expires_at")
      .eq("id", 1)
      .maybeSingle();
    if (data?.token && new Date(data.expires_at) > new Date(Date.now() + 12 * 60 * 60 * 1000)) {
      return data.token as string;
    }
  }
  const token = await fetchFreshToken();
  // Refresh a bit before the real 7-day expiry to stay safely ahead of it.
  const expiresAt = new Date(Date.now() + 6.5 * 24 * 60 * 60 * 1000).toISOString();
  await supabase.from("vtu_ng_auth").upsert({ id: 1, token, expires_at: expiresAt });
  return token;
}

export function isVtuConfigured(): boolean {
  return !!VTU_NG_USERNAME && !!VTU_NG_PASSWORD;
}

/**
 * Calls a VTU.ng v2 endpoint with the cached token, retrying once with a
 * freshly-fetched token if the cached one turns out to be invalid (a rare
 * race — see getToken's comment — self-heals without needing distributed locks).
 */
export async function callVTUNG(
  supabase: ReturnType<typeof adminClient>,
  endpoint: string,
  body: Record<string, unknown>,
): Promise<any> {
  const doCall = async (token: string) => {
    const res = await fetchWithTimeout(`${VTU_NG_API_BASE}${endpoint}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, 25_000);
    return { status: res.status, data: await res.json() };
  };

  let token = await getToken(supabase);
  let result = await doCall(token);

  if (result.status === 403 && ["jwt_auth_invalid_token", "rest_forbidden"].includes(result.data?.code)) {
    token = await getToken(supabase, true);
    result = await doCall(token);
  }

  return result.data;
}

// Order states that mean "we don't have a final answer yet".
export const NON_TERMINAL_STATUSES = ["processing-api", "queued-api", "initiated-api", "pending", "on-hold"];
export const SUCCESS_STATUSES = ["completed-api"];
// Anything else (refunded, failed, cancelled) is treated as a refund.
