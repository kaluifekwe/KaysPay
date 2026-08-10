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
const TOKEN_REFRESH_LOCK = "vtu-ng-token-refresh";
const TOKEN_REFRESH_WAIT_MS = 250;
const TOKEN_REFRESH_WAIT_ATTEMPTS = 20;

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
async function readCachedToken(supabase: ReturnType<typeof adminClient>) {
  const { data } = await supabase
    .from("vtu_ng_auth")
    .select("token, expires_at")
    .eq("id", 1)
    .maybeSingle();
  return data;
}

function isUsableToken(
  data: { token?: string; expires_at?: string } | null,
  minimumLifetimeMs: number,
  rejectedToken?: string,
): data is { token: string; expires_at: string } {
  return !!data?.token && data.token !== rejectedToken &&
    new Date(data.expires_at ?? 0).getTime() > Date.now() + minimumLifetimeMs;
}

/**
 * Returns the shared JWT. VTU.ng invalidates older JWTs whenever a new one is
 * issued, so a database lock prevents concurrent cold starts from repeatedly
 * invalidating one another's tokens.
 */
export async function getToken(
  supabase: ReturnType<typeof adminClient>,
  forceRefresh = false,
  rejectedToken?: string,
): Promise<string> {
  const cached = await readCachedToken(supabase);
  if (!forceRefresh && isUsableToken(cached, 12 * 60 * 60 * 1000)) return cached.token;

  const { data: acquired, error: lockError } = await supabase.rpc("try_acquire_job_lock", {
    p_job_name: TOKEN_REFRESH_LOCK,
    p_hold_seconds: 30,
  });
  if (lockError) throw new VTUAuthError("VTU provider authentication is temporarily unavailable");

  if (!acquired) {
    for (let attempt = 0; attempt < TOKEN_REFRESH_WAIT_ATTEMPTS; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, TOKEN_REFRESH_WAIT_MS));
      const refreshed = await readCachedToken(supabase);
      if (isUsableToken(refreshed, 60_000, rejectedToken)) return refreshed.token;
    }
    throw new VTUAuthError("VTU provider authentication is busy; please retry");
  }

  try {
    const latest = await readCachedToken(supabase);
    if (isUsableToken(latest, 60_000, forceRefresh ? rejectedToken : undefined)) return latest.token;

    const token = await fetchFreshToken();
    const expiresAt = new Date(Date.now() + 6.5 * 24 * 60 * 60 * 1000).toISOString();
    const { error: saveError } = await supabase
      .from("vtu_ng_auth")
      .upsert({ id: 1, token, expires_at: expiresAt });
    if (saveError) throw new VTUAuthError("VTU provider authentication could not be cached");
    return token;
  } finally {
    await supabase.rpc("release_job_lock", { p_job_name: TOKEN_REFRESH_LOCK });
  }
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
    token = await getToken(supabase, true, token);
    result = await doCall(token);
  }

  return result.data;
}

// Order states that mean "we don't have a final answer yet".
export const NON_TERMINAL_STATUSES = ["processing-api", "queued-api", "initiated-api", "pending", "on-hold"];
export const SUCCESS_STATUSES = ["completed-api"];
export const FAILURE_STATUSES = [
  "failed-api", "refunded-api", "cancelled-api", "canceled-api", "declined-api", "reversed-api",
  "failed", "refunded", "cancelled", "canceled", "declined", "reversed",
];

export type VtuNgOutcome = "success" | "pending" | "failed" | "unknown";

/** Never infer failure from an unfamiliar provider status. */
export function vtuNgOutcome(status: unknown): VtuNgOutcome {
  const normalized = String(status ?? "").trim().toLowerCase();
  if (SUCCESS_STATUSES.includes(normalized)) return "success";
  if (NON_TERMINAL_STATUSES.includes(normalized)) return "pending";
  if (FAILURE_STATUSES.includes(normalized)) return "failed";
  return "unknown";
}
