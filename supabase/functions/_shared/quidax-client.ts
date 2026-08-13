import { fetchWithTimeout } from "./provider-fetch.ts";
import { redactSecrets } from "./redact.ts";

// Quidax exchange API (sub-accounts, wallets, deposits, withdrawals, instant
// swap) — see https://docs.quidax.io/reference/introduction-user-accounts.
// Every call here acts on a specific sub-account (Quidax's own `user_id`),
// never on KaysPay's own merchant balance — Phase 1 only needs sub-account
// creation and deposit-address generation; buy/sell/withdraw land in later
// phases against this same client.
const QUIDAX_SECRET_KEY = Deno.env.get("QUIDAX_SECRET_KEY")?.trim();
const QUIDAX_WEBHOOK_SECRET = Deno.env.get("QUIDAX_WEBHOOK_SECRET")?.trim();
const QUIDAX_BASE_URL = "https://openapi.quidax.io/exchange-open-api/api/v1";

export class QuidaxError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export function isQuidaxConfigured(): boolean {
  return !!QUIDAX_SECRET_KEY;
}

async function callQuidax(
  path: string,
  method = "GET",
  body?: Record<string, unknown>,
): Promise<{ status: number; data: any }> {
  if (!QUIDAX_SECRET_KEY) throw new QuidaxError("Quidax not configured");

  const response = await fetchWithTimeout(`${QUIDAX_BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${QUIDAX_SECRET_KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  }, 20_000);

  const text = await response.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    console.error("Quidax returned a non-JSON response:", redactSecrets(text.slice(0, 300)));
    data = { status: "error", message: "Quidax returned an unexpected response" };
  }
  return { status: response.status, data };
}

export interface QuidaxSubAccount {
  id: string;
  sn: string;
  email: string;
}

/**
 * Creates a Quidax sub-account for a KaysPay user. Email must be unique and
 * immutable on Quidax's side. Quidax's own "already exists" (409) is a real,
 * recoverable case here — not just a caller bug — since a prior call can
 * succeed on Quidax's side while the local crypto_accounts insert that was
 * meant to follow it never lands (a crashed request, a transient DB error,
 * or — as happened once — several retries against a not-yet-valid API key
 * where one attempt got further than the others). getOrCreateCryptoAccount
 * recovers from this via findSubAccountByEmail rather than failing forever.
 */
export async function createSubAccount(params: {
  email: string;
  firstName: string;
  lastName: string;
}): Promise<QuidaxSubAccount> {
  const { status, data } = await callQuidax("/users", "POST", {
    email: params.email,
    first_name: params.firstName,
    last_name: params.lastName,
  });
  if (status >= 400 || data?.status !== "success") {
    throw new QuidaxError(data?.message || "Could not create Quidax sub-account", status);
  }
  return { id: data.data.id, sn: data.data.sn, email: data.data.email };
}

/** All sub-accounts under this merchant — used only to recover an orphaned
 * sub-account (see createSubAccount's doc comment), never on the normal path. */
export async function getSubAccounts(): Promise<QuidaxSubAccount[]> {
  const { status, data } = await callQuidax("/users", "GET");
  if (status >= 400 || data?.status !== "success") {
    throw new QuidaxError(data?.message || "Could not list Quidax sub-accounts", status);
  }
  return (data.data as any[]).map((u) => ({ id: String(u.id), sn: String(u.sn), email: String(u.email) }));
}

export interface QuidaxWallet {
  currency: string;
  balance: string;
  locked: string;
  isCrypto: boolean;
  depositAddress: string | null;
}

/** Live wallet balances for a sub-account, straight from Quidax — never cached. */
export async function getSubAccountWallets(quidaxUserId: string): Promise<QuidaxWallet[]> {
  const { status, data } = await callQuidax(`/users/${encodeURIComponent(quidaxUserId)}/wallets`, "GET");
  if (status >= 400 || data?.status !== "success") {
    throw new QuidaxError(data?.message || "Could not fetch Quidax wallets", status);
  }
  return (data.data as any[]).map((w) => ({
    currency: String(w.currency),
    balance: String(w.balance),
    locked: String(w.locked),
    isCrypto: !!w.is_crypto,
    depositAddress: w.deposit_address ?? null,
  }));
}

export interface QuidaxDepositAddress {
  id: string;
  currency: string;
  network: string;
  address: string;
}

/**
 * Creates (or returns the existing) deposit address for a sub-account's
 * given currency+network — Quidax's own endpoint is idempotent per
 * currency+network, so this is safe to call every time the Deposit screen
 * opens rather than caching an address KaysPay itself has to keep in sync.
 */
export async function createDepositAddress(params: {
  quidaxUserId: string;
  currency: string;
  network: string;
}): Promise<QuidaxDepositAddress> {
  const { status, data } = await callQuidax(
    `/users/${encodeURIComponent(params.quidaxUserId)}/wallets/${encodeURIComponent(params.currency)}/addresses?network=${encodeURIComponent(params.network)}`,
    "POST",
  );
  if (status >= 400 || data?.status !== "success") {
    throw new QuidaxError(data?.message || "Could not generate a deposit address", status);
  }
  const addr = data.data.address ?? data.data.data?.address;
  if (!addr) throw new QuidaxError("Quidax did not return a deposit address");
  return {
    id: String(data.data.id),
    currency: String(data.data.currency),
    network: String(data.data.network ?? params.network),
    address: String(addr),
  };
}

/**
 * Verifies a Quidax webhook's HMAC-SHA256 signature. Header format is
 * `t=<timestamp>,s=<signature>`; the signed payload is `${timestamp}.${rawBody}`
 * — must run against the RAW request body (before any JSON.parse), same
 * discipline as every other provider webhook in this codebase.
 */
export async function verifyQuidaxWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
): Promise<boolean> {
  if (!QUIDAX_WEBHOOK_SECRET || !signatureHeader) return false;

  const parts = Object.fromEntries(
    signatureHeader.split(",").map((seg) => {
      const [key, value] = seg.split("=");
      return [key?.trim(), value?.trim()];
    }),
  );
  const timestamp = parts["t"];
  const signature = parts["s"];
  if (!timestamp || !signature) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(QUIDAX_WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${rawBody}`),
  );
  const expected = Array.from(new Uint8Array(signed))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}
