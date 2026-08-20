import { fetchWithTimeout } from "./provider-fetch.ts";
import { proxiedFetch } from "./proxied-fetch.ts";
import { redactSecrets } from "./redact.ts";

const PAYSTACK_SECRET_KEY = Deno.env.get("PAYSTACK_SECRET_KEY")?.trim();
const PAYSTACK_BASE_URL = "https://api.paystack.co";
const PAYSTACK_DVA_BANK_SLUG = Deno.env.get("PAYSTACK_DVA_BANK_SLUG")?.trim();

export function isPaystackConfigured(): boolean {
  return !!PAYSTACK_SECRET_KEY;
}

export async function callPaystack(
  path: string,
  method = "GET",
  body?: Record<string, unknown>,
): Promise<{ status: number; data: any }> {
  if (!PAYSTACK_SECRET_KEY) throw new Error("Paystack not configured");

  const response = await fetchWithTimeout(`${PAYSTACK_BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  }, 25_000, proxiedFetch);

  const text = await response.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    console.error("Paystack returned a non-JSON response:", redactSecrets(text.slice(0, 300)));
    data = { status: false, message: "Paystack returned an unexpected response" };
  }
  return { status: response.status, data };
}

export async function getOrCreatePaystackCustomer(params: {
  email: string;
  firstName: string;
  lastName: string;
  phone?: string;
}): Promise<{ status: number; data: any }> {
  const lookup = await callPaystack(`/customer/${encodeURIComponent(params.email)}`);
  if (lookup.status < 400 && lookup.data?.status === true && lookup.data?.data?.customer_code) {
    return lookup;
  }
  if (lookup.status !== 404) return lookup;

  return callPaystack("/customer", "POST", {
    email: params.email,
    first_name: params.firstName,
    last_name: params.lastName,
    ...(params.phone ? { phone: params.phone } : {}),
  });
}

async function resolvePreferredBank(bankName?: string): Promise<{ status: number; slug?: string; message?: string }> {
  if (PAYSTACK_DVA_BANK_SLUG) return { status: 200, slug: PAYSTACK_DVA_BANK_SLUG };

  const providers = await callPaystack("/dedicated_account/available_providers");
  if (providers.status >= 400 || providers.data?.status !== true) {
    return { status: providers.status, message: providers.data?.message || "Could not fetch available Paystack banks" };
  }

  const available = Array.isArray(providers.data?.data) ? providers.data.data : [];
  const normalizedBankName = bankName?.trim().toLowerCase();
  const selected = normalizedBankName
    ? available.find((provider: any) => String(provider?.bank_name || "").trim().toLowerCase() === normalizedBankName)
    : available[0];
  const slug = selected?.provider_slug || selected?.slug;
  return slug
    ? { status: 200, slug: String(slug) }
    : {
      status: 503,
      message: bankName
        ? "The bank for this Paystack account is not currently available for requery"
        : "No Paystack virtual-account bank is currently available",
    };
}

export async function createPaystackDedicatedAccount(customerCode: string) {
  const bank = await resolvePreferredBank();
  if (!bank.slug) {
    return { status: bank.status, data: { status: false, message: bank.message } };
  }
  return callPaystack("/dedicated_account", "POST", {
    customer: customerCode,
    preferred_bank: bank.slug,
  });
}

export async function requeryPaystackDedicatedAccount(accountNumber: string, bankName: string) {
  const bank = await resolvePreferredBank(bankName);
  if (!bank.slug) {
    return { status: bank.status, data: { status: false, message: bank.message } };
  }
  const query = new URLSearchParams({
    account_number: accountNumber,
    provider_slug: bank.slug,
  });
  return callPaystack(`/dedicated_account/requery?${query.toString()}`);
}

/** Read-only list used by the funding reconciliation sweep. */
export async function listPaystackTransactions(params: {
  from: string;
  to: string;
  page: number;
  perPage?: number;
}) {
  const query = new URLSearchParams({
    status: "success",
    from: params.from,
    to: params.to,
    page: String(params.page),
    perPage: String(params.perPage ?? 100),
  });
  return callPaystack(`/transaction?${query.toString()}`);
}

// --- Transfer fallback (used only when Flutterwave's send leg rejects a
// transfer already validated by Flutterwave's own resolve) ---
//
// Paystack and Flutterwave use DIFFERENT, incompatible bank code schemes —
// a Flutterwave bank_code can't be reused directly against Paystack. The
// fallback path in transfer-send looks up the matching Paystack bank by
// NAME instead, then re-resolves the account through Paystack and compares
// the resolved holder name against what Flutterwave already verified.
// That comparison is the real safety net: even an imperfect name-based bank
// match can't send money to the wrong place, because a wrong bank match
// will resolve to a different (or no) account name and the caller aborts
// instead of proceeding.

export interface PaystackBank {
  name: string;
  code: string;
}

/** Full Nigerian bank list, Paystack's own code scheme — NOT Flutterwave's. */
export async function listPaystackBanks(): Promise<PaystackBank[]> {
  const { status, data } = await callPaystack("/bank?country=nigeria&currency=NGN&perPage=200");
  if (status >= 400 || data?.status !== true) {
    throw new Error(data?.message || "Could not fetch Paystack's bank list");
  }
  return (data.data ?? []).map((b: any) => ({ name: String(b.name ?? ""), code: String(b.code ?? "") }));
}

/** Resolves an account number against a Paystack bank code to its registered holder name. */
export async function resolvePaystackAccount(params: { accountNumber: string; bankCode: string }) {
  const query = new URLSearchParams({ account_number: params.accountNumber, bank_code: params.bankCode });
  return callPaystack(`/bank/resolve?${query.toString()}`);
}

/** Must exist before a transfer can be sent — Paystack transfers target a recipient code, not raw account details. */
export async function createPaystackTransferRecipient(params: {
  name: string;
  accountNumber: string;
  bankCode: string;
}) {
  return callPaystack("/transferrecipient", "POST", {
    type: "nuban",
    name: params.name,
    account_number: params.accountNumber,
    bank_code: params.bankCode,
    currency: "NGN",
  });
}

/**
 * Sends NGN to a previously-created recipient. `reference` is KaysPay's own
 * transaction idempotency key (same one already used with Flutterwave) —
 * Paystack rejects a duplicate reference outright, so a retried request can
 * never double-send here either.
 */
/**
 * Requery a specific transfer's real status by our own reference — the
 * fallback for when transfer.success/.failed/.reversed never arrives (a
 * lost webhook delivery). Same "requery, don't guess" discipline as
 * crypto-buy-reconcile.
 */
export function verifyPaystackTransfer(reference: string) {
  return callPaystack(`/transfer/verify/${encodeURIComponent(reference)}`);
}

export async function initiatePaystackTransfer(params: {
  amountKobo: number;
  recipientCode: string;
  reference: string;
  reason: string;
}) {
  return callPaystack("/transfer", "POST", {
    source: "balance",
    amount: params.amountKobo,
    recipient: params.recipientCode,
    reason: params.reason,
    reference: params.reference,
  });
}
