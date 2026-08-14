import { fetchWithTimeout } from "./provider-fetch.ts";
import { redactSecrets } from "./redact.ts";

// Quidax Ramp — the on/off-ramp product, separate from the exchange API in
// quidax-client.ts: different host, different auth header (x-private-key,
// not a Bearer token) and its own credential. Used for Buy, where the
// customer pays Naira into a Quidax-generated one-time bank account and
// Quidax delivers USDT straight to the destination address we name (the
// customer's own sub-account deposit address). Deliberately NOT the
// alternative design where KaysPay debits the in-app wallet and pushes
// Naira from its own Quidax balance — that would require KaysPay to hold
// Naira float at Quidax, which the owner ruled out.
// Quidax confirmed that Ramp and Exchange use the same merchant secret. The
// Ramp host still requires its documented x-private-key header.
const QUIDAX_SECRET_KEY = Deno.env.get("QUIDAX_SECRET_KEY")?.trim();
const RAMP_BASE_URL = "https://ramp-be.quidax.io/api/v1/merchants";

export class QuidaxRampError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export function isQuidaxRampConfigured(): boolean {
  return !!QUIDAX_SECRET_KEY;
}

async function callRamp(
  path: string,
  method = "GET",
  body?: Record<string, unknown>,
): Promise<{ status: number; data: any }> {
  if (!QUIDAX_SECRET_KEY) throw new QuidaxRampError("Quidax Ramp not configured");

  const response = await fetchWithTimeout(`${RAMP_BASE_URL}${path}`, {
    method,
    headers: {
      "x-private-key": QUIDAX_SECRET_KEY,
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
    console.error("Quidax Ramp returned a non-JSON response:", redactSecrets(text.slice(0, 300)));
    data = { status: "error", message: "Quidax returned an unexpected response" };
  }
  return { status: response.status, data };
}

// Ramp answers "ok" on success, unlike the exchange API's "success".
function unwrap(status: number, data: any, fallbackMessage: string) {
  if (status >= 400 || (data?.status && data.status !== "ok")) {
    throw new QuidaxRampError(data?.message || fallbackMessage, status);
  }
  return data?.data ?? {};
}

export interface OnRampInitiated {
  publicId: string;
  reference: string;
  status: string;
  /** Estimated USDT the customer receives — Quidax re-prices at settlement. */
  toAmount: number;
}

/**
 * Opens a Naira -> USDT purchase. `address`/`network` name where the crypto
 * is delivered: always the customer's OWN sub-account deposit address, so
 * the purchase lands in the same balance Sell and Withdraw spend from.
 *
 * The customer's name is sent because Quidax name-matches it against the
 * bank account the Naira actually arrives from, and rejects mismatches —
 * so a purchase paid from someone else's account will not settle.
 */
export async function initiateOnRamp(params: {
  merchantReference: string;
  ngnAmount: number;
  email: string;
  firstName: string;
  lastName: string;
  address: string;
  network: string;
}): Promise<OnRampInitiated> {
  const { status, data } = await callRamp("/custodial/on_ramp_transactions/initiate", "POST", {
    from_currency: "ngn",
    to_currency: "usdt",
    from_amount: String(params.ngnAmount),
    merchant_reference: params.merchantReference,
    customer: {
      email: params.email,
      first_name: params.firstName,
      last_name: params.lastName,
    },
    wallet_address: {
      address: params.address,
      network: params.network,
    },
  });
  const payload = unwrap(status, data, "Could not start this purchase");
  return {
    publicId: String(payload.public_id ?? ""),
    reference: String(payload.reference ?? ""),
    status: String(payload.status ?? "pending"),
    toAmount: Number(payload.to_amount) || 0,
  };
}

export interface OnRampBankAccount {
  accountName: string;
  accountNumber: string;
  bankName: string;
  /** What the customer must transfer, INCLUDING processor fee and VAT. */
  amountExpected: number;
  /** The purchase amount before those charges. */
  amount: number;
  processorFee: number;
  vat: number;
  /** Merchant markup configured and settled by Quidax, when itemised. */
  merchantMarkup: number;
}

function readMoney(payload: Record<string, unknown>, ...keys: string[]): number {
  for (const key of keys) {
    const value = Number(payload[key]);
    if (Number.isFinite(value) && value >= 0) return value;
  }
  return 0;
}

/**
 * Turns an initiated purchase into payment instructions — Quidax generates a
 * single-use bank account for this one transaction. The customer must send
 * exactly `amountExpected`, which is the purchase amount plus Quidax's
 * processor fee and VAT.
 */
export async function confirmOnRamp(merchantReference: string): Promise<OnRampBankAccount> {
  const { status, data } = await callRamp(
    `/custodial/on_ramp_transactions/${encodeURIComponent(merchantReference)}/confirm`,
    "POST",
  );
  const payload = unwrap(status, data, "Could not generate payment details");
  const accountNumber = String(payload.account_number ?? "");
  if (!accountNumber) throw new QuidaxRampError("Quidax did not return a payment account");
  return {
    accountName: String(payload.account_name ?? ""),
    accountNumber,
    bankName: String(payload.bank_name ?? ""),
    amountExpected: Number(payload.amount_expected) || 0,
    amount: Number(payload.amount) || 0,
    processorFee: readMoney(payload, "processor_fee", "processing_fee"),
    vat: readMoney(payload, "vat", "vat_amount"),
    // Quidax includes this in amount_expected and settles it to the merchant
    // markup wallet. Do not calculate or add it again inside Kay's Pay.
    merchantMarkup: readMoney(payload, "merchant_markup", "markup", "markup_amount", "merchant_fee"),
  };
}

export interface PurchaseLimits {
  min: number;
  max: number;
}

/** Quidax's own min/max per fiat purchase — read live rather than hardcoded,
 * since breaching it fails the transaction after the customer has already
 * been shown an account to pay into. */
export async function getBuyLimits(currency = "ngn"): Promise<PurchaseLimits | null> {
  try {
    const { status, data } = await callRamp(`/purchase_limits/buy?currency_symbol=${encodeURIComponent(currency)}`);
    const payload = unwrap(status, data, "Could not read purchase limits");
    const min = Number(payload.min_value);
    const max = Number(payload.max_value);
    if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
    return { min, max };
  } catch (e) {
    console.error("quidax-ramp: could not read buy limits:", e instanceof Error ? e.message : e);
    return null;
  }
}
