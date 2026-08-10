import { fetchWithTimeout } from "./provider-fetch.ts";
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
  }, 25_000);

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
