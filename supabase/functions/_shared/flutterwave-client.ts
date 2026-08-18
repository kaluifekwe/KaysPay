import { adminClient } from "./auth.ts";
import { fetchWithTimeout } from "./provider-fetch.ts";

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
  const res = await fetchWithTimeout(FLW_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: FLW_CLIENT_ID ?? "",
      client_secret: FLW_CLIENT_SECRET ?? "",
      grant_type: "client_credentials",
    }),
  }, 15_000);
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
    const res = await fetchWithTimeout(`${FLW_BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(idempotencyKey ? { "X-Idempotency-Key": idempotencyKey } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    }, 25_000);
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
    // Confirmed 2026-08-04: unlike 035/Wema (which Flutterwave silently
    // overrode to a different bank, "Indulge," on an earlier live attempt),
    // 044/Access Bank is honored — real users' generated accounts show as
    // Access Bank, and transfers to them reflect in the wallet correctly.
    bank_code: "044",
  }, idempotencyKey);
}

/** Read-only list used by the funding reconciliation sweep. */
export function listFlutterwaveCharges(
  supabase: ReturnType<typeof adminClient>,
  params: { from: string; to: string; page: number; size?: number },
) {
  const query = new URLSearchParams({
    status: "succeeded",
    from: params.from,
    to: params.to,
    page: String(params.page),
    size: String(params.size ?? 50),
  });
  return callFlutterwave(supabase, `/charges?${query.toString()}`, "GET");
}

/** NG bank list for the Transfer bank picker — {id, code, name}[] once unwrapped. */
export function listFlutterwaveBanks(supabase: ReturnType<typeof adminClient>) {
  return callFlutterwave(supabase, "/banks?country=NG", "GET");
}

/** Resolves an account number to its registered holder name before a transfer. */
export function resolveFlutterwaveAccount(
  supabase: ReturnType<typeof adminClient>,
  params: { accountNumber: string; bankCode: string },
) {
  return callFlutterwave(supabase, "/banks/account-resolve", "POST", {
    account: { code: params.bankCode, number: params.accountNumber },
    currency: "NGN",
  });
}

/**
 * Sends NGN straight to an external bank account — the payout leg of
 * Transfer. `action: "instant"` per Flutterwave's direct-transfer flow.
 * `idempotencyKey` is KaysPay's own transaction id, so a retried request
 * (network blip, client re-submit) can never double-send.
 */
export function createDirectBankTransfer(
  supabase: ReturnType<typeof adminClient>,
  params: { amountKobo: number; accountNumber: string; bankCode: string; reference: string; narration: string },
  idempotencyKey: string,
) {
  return callFlutterwave(supabase, "/direct-transfers", "POST", {
    action: "instant",
    reference: params.reference,
    narration: params.narration,
    payment_instruction: {
      source_currency: "NGN",
      amount: { applies_to: "source_currency", value: Math.round(params.amountKobo / 100) },
      recipient: { bank: { account_number: params.accountNumber, code: params.bankCode } },
      destination_currency: "NGN",
    },
    type: "bank",
  }, idempotencyKey);
}
