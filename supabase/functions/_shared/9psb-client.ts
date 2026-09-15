import { adminClient } from "./auth.ts";
import { fetchWithTimeout } from "./provider-fetch.ts";
import { proxiedFetch } from "./proxied-fetch.ts";

// 9PSB WAAS (Wallet-as-a-Service) — bearer-token auth via client credentials,
// same shape as Flutterwave's OAuth2 client-credentials flow, not Paystack's
// static key. Unlike Flutterwave's fixed 600s token life, 9PSB returns a
// dynamic expiresIn per authenticate call, so the cache computes its own
// safety margin from the real response instead of a hardcoded constant.
// Confirmed against 9PSB's own docx + Postman collection (WAAS product,
// July2027 revision) and the sandbox base URL in the credentials the owner
// provided separately -- values never logged or reproduced here.
//
// Sandbox is plain HTTP on a bare IP, no TLS -- NINEPSB_BASE_URL is expected
// to be just the host (e.g. "http://102.216.128.75:9090"), with every WAAS
// path living under /waas/api/v1.
const PSB_BASE_URL = Deno.env.get("NINEPSB_BASE_URL");
const PSB_USERNAME = Deno.env.get("NINEPSB_USERNAME");
const PSB_PASSWORD = Deno.env.get("NINEPSB_PASSWORD");
const PSB_CLIENT_ID = Deno.env.get("NINEPSB_CLIENT_ID");
const PSB_CLIENT_SECRET = Deno.env.get("NINEPSB_CLIENT_SECRET");
const WAAS_PREFIX = "/waas/api/v1";

export class NinePsbAuthError extends Error {}

export function is9PsbConfigured(): boolean {
  return !!PSB_BASE_URL && !!PSB_USERNAME && !!PSB_PASSWORD && !!PSB_CLIENT_ID && !!PSB_CLIENT_SECRET;
}

async function fetchFreshToken(): Promise<{ token: string; expiresInSeconds: number }> {
  const res = await fetchWithTimeout(`${PSB_BASE_URL}${WAAS_PREFIX}/authenticate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: PSB_USERNAME,
      password: PSB_PASSWORD,
      clientId: PSB_CLIENT_ID,
      clientSecret: PSB_CLIENT_SECRET,
    }),
  }, 15_000, proxiedFetch);
  const data = await res.json();
  if (!data?.accessToken) {
    throw new NinePsbAuthError(data?.message || "9PSB authentication failed");
  }
  return {
    token: data.accessToken as string,
    // Confirmed live against the sandbox (2026-09-15): 9PSB returns
    // expiresIn as a numeric STRING (e.g. "7200"), not a number -- a plain
    // `typeof === "number"` check silently fell back to 300s always.
    expiresInSeconds: Number.isFinite(Number(data.expiresIn)) && Number(data.expiresIn) > 0 ? Number(data.expiresIn) : 300,
  };
}

/** Shared, cached token — refreshed with a safety margin computed from the real expiresIn. */
export async function getToken(supabase: ReturnType<typeof adminClient>, forceRefresh = false): Promise<string> {
  if (!forceRefresh) {
    const { data } = await supabase
      .from("nine_psb_auth")
      .select("access_token, expires_at")
      .eq("id", 1)
      .maybeSingle();
    if (data?.access_token && new Date(data.expires_at) > new Date(Date.now() + 90 * 1000)) {
      return data.access_token as string;
    }
  }
  const { token, expiresInSeconds } = await fetchFreshToken();
  // Refresh at 80% of the real lifetime, floored at 30s, so a short-lived
  // sandbox token still leaves a usable margin instead of expiring mid-call.
  const safetyLifetimeSeconds = Math.max(30, Math.floor(expiresInSeconds * 0.8));
  const expiresAt = new Date(Date.now() + safetyLifetimeSeconds * 1000).toISOString();
  await supabase.from("nine_psb_auth").upsert({ id: 1, access_token: token, expires_at: expiresAt, updated_at: new Date().toISOString() });
  return token;
}

/**
 * Calls a 9PSB WAAS endpoint with the cached token, retrying once with a
 * freshly-fetched token on a 401 — same self-healing pattern as
 * callFlutterwave.
 */
export async function call9Psb(
  supabase: ReturnType<typeof adminClient>,
  path: string,
  method: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; data: any }> {
  const doCall = async (token: string) => {
    const res = await fetchWithTimeout(`${PSB_BASE_URL}${WAAS_PREFIX}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    }, 25_000, proxiedFetch);
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

export function identityInitiate(
  supabase: ReturnType<typeof adminClient>,
  params: { transactionRef: string; bvn?: string; nin?: string; phoneNo?: string; type: "OTP" | "FACIAL"; image?: string },
) {
  return call9Psb(supabase, "/identity/initiate", "POST", {
    transactionRef: params.transactionRef,
    bvn: params.bvn,
    nin: params.nin,
    phoneNo: params.phoneNo,
    type: params.type,
    image: params.image,
  });
}

export function identityVerifyOtp(
  supabase: ReturnType<typeof adminClient>,
  params: { transactionRef: string; otp: string },
) {
  return call9Psb(supabase, "/identity/verify-otp", "POST", {
    transactionRef: params.transactionRef,
    otp: params.otp,
  });
}

/** Pre-open duplicate check — 9PSB rejects a second open_wallet for the same BVN/NIN with code 94. */
export function getWallet(
  supabase: ReturnType<typeof adminClient>,
  params: { bvn?: string; nin?: string },
) {
  return call9Psb(supabase, "/get_wallet", "POST", params.bvn ? { bvn: params.bvn } : { nin: params.nin });
}

export function openWallet(
  supabase: ReturnType<typeof adminClient>,
  params: {
    transactionTrackingRef: string;
    lastName: string;
    otherNames: string;
    phoneNo: string;
    gender: 0 | 1;
    dateOfBirth: string; // dd/MM/yyyy
    address: string;
    bvn?: string;
    nationalIdentityNo?: string;
    email?: string;
  },
) {
  return call9Psb(supabase, "/open_wallet", "POST", {
    transactionTrackingRef: params.transactionTrackingRef,
    lastName: params.lastName,
    otherNames: params.otherNames,
    phoneNo: params.phoneNo,
    gender: params.gender,
    dateOfBirth: params.dateOfBirth,
    address: params.address,
    bvn: params.bvn,
    nationalIdentityNo: params.nationalIdentityNo,
    email: params.email,
  });
}

export function walletEnquiry(supabase: ReturnType<typeof adminClient>, params: { accountNo: string }) {
  return call9Psb(supabase, "/wallet_enquiry", "POST", params);
}

export function walletStatus(supabase: ReturnType<typeof adminClient>, params: { accountNo: string }) {
  return call9Psb(supabase, "/wallet_status", "POST", params);
}

/** Beneficiary name resolution before a transfer — standard NIP name-enquiry pattern. */
export function otherBanksEnquiry(
  supabase: ReturnType<typeof adminClient>,
  params: { bank: string; number: string },
) {
  return call9Psb(supabase, "/other_banks_enquiry", "POST", {
    customer: { account: { bank: params.bank, number: params.number } },
  });
}

/** Wallet -> other bank transfer-out. */
export function walletOtherBanks(
  supabase: ReturnType<typeof adminClient>,
  params: {
    senderAccountNumber: string;
    senderName: string;
    bank: string;
    recipientName: string;
    recipientNumber: string;
    amountNaira: string;
    reference: string;
    narration: string;
    isFee?: boolean;
    merchantFeeAccount?: string;
    merchantFeeAmount?: string;
  },
) {
  return call9Psb(supabase, "/wallet_other_banks", "POST", {
    customer: {
      account: {
        bank: params.bank,
        name: params.recipientName,
        number: params.recipientNumber,
        senderaccountnumber: params.senderAccountNumber,
        sendername: params.senderName,
      },
    },
    narration: params.narration,
    order: { amount: params.amountNaira, country: "NGA", currency: "NGN", description: params.narration },
    transaction: { reference: params.reference },
    merchant: {
      isFee: params.isFee ?? false,
      merchantFeeAccount: params.merchantFeeAccount ?? "",
      merchantFeeAmount: params.merchantFeeAmount ?? "",
    },
  });
}

/** Transaction status query — required per 9PSB's own guidance for ambiguous NIBSS codes (09/96/97/98/99) before assuming success or failure. */
export function walletRequery(supabase: ReturnType<typeof adminClient>, params: { transactionId: string }) {
  return call9Psb(supabase, "/wallet_requery", "POST", params);
}

/** Confirms an inbound funding webhook before crediting — 9PSB's webhook has no signature, only Basic Auth, so this is the real integrity check. */
export function notificationRequery(
  supabase: ReturnType<typeof adminClient>,
  params: { sessionID: string; accountNumber: string },
) {
  return call9Psb(supabase, "/notification_requery", "POST", params);
}

export function getBanks(supabase: ReturnType<typeof adminClient>) {
  return call9Psb(supabase, "/get_banks", "POST", {});
}
