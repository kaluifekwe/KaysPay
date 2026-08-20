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
// Ramp uses the private SecretKey from the merchant API record. Keep it
// separate from the Exchange APIKey used by quidax-client.ts: the two
// credentials have different scopes and authentication headers.
const QUIDAX_RAMP_PRIVATE_KEY = Deno.env.get("QUIDAX_RAMP_PRIVATE_KEY")?.trim();
const RAMP_BASE_URL = "https://ramp-be.quidax.io/api/v1/merchants";

export class QuidaxRampError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export function isQuidaxRampConfigured(): boolean {
  return !!QUIDAX_RAMP_PRIVATE_KEY;
}

async function callRamp(
  path: string,
  method = "GET",
  body?: Record<string, unknown>,
): Promise<{ status: number; data: any }> {
  if (!QUIDAX_RAMP_PRIVATE_KEY) throw new QuidaxRampError("Quidax Ramp not configured");

  const response = await fetchWithTimeout(`${RAMP_BASE_URL}${path}`, {
    method,
    headers: {
      "x-private-key": QUIDAX_RAMP_PRIVATE_KEY,
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

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(signed))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verifies Ramp's `x-ramp-signature` header — a hex HMAC-SHA256 keyed on the
 * SAME Ramp secret used for API auth (Ramp has no separate webhook secret;
 * its dashboard only exposes a Webhook URL field).
 *
 * Note this is a completely different scheme from the exchange API's
 * `quidax-signature` (`t=...,s=...` over `timestamp.rawBody`, keyed on
 * QUIDAX_WEBHOOK_SECRET) — which is exactly why Ramp gets its own function
 * rather than sharing crypto-quidax-webhook.
 *
 * Quidax's own docs disagree with themselves about what is signed: the prose
 * says "based solely on the data object", the Node sample signs
 * JSON.stringify(req.body) — i.e. the whole envelope, re-serialised by
 * Express rather than the bytes actually sent. We therefore accept any of
 * those three readings. That is not a weakening: every candidate is an HMAC
 * under the same secret, so forging one still requires the secret. Once a
 * real delivery lands, the log line below tells us which reading is the true
 * one, and this can be narrowed to just that.
 */
export async function verifyRampWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
): Promise<boolean> {
  if (!QUIDAX_RAMP_PRIVATE_KEY || !signatureHeader) return false;
  const provided = signatureHeader.trim().toLowerCase();

  const candidates = new Map<string, string>([["raw body", rawBody]]);
  try {
    const parsed = JSON.parse(rawBody);
    candidates.set("re-serialised body", JSON.stringify(parsed));
    if (parsed && typeof parsed === "object" && "data" in parsed) {
      candidates.set("data object only", JSON.stringify(parsed.data));
    }
  } catch {
    // Non-JSON body — the raw candidate is all we can check.
  }

  for (const [label, candidate] of candidates) {
    if (timingSafeEqual(await hmacHex(QUIDAX_RAMP_PRIVATE_KEY, candidate), provided)) {
      console.log(`quidax-ramp: webhook signature matched on "${label}"`);
      return true;
    }
  }
  return false;
}

export interface RefundAccountDetails {
  accountName: string;
  accountNumber: string;
  bankName: string;
  bankCode: string;
}

/**
 * Looks up the account holder's name for a bank account BEFORE submitting it
 * as a refund destination — same "never trust a typed-in number alone"
 * discipline as transfer-resolve-account. Quidax's own docs mark this step
 * optional, but skipping it means the first (and only) feedback on a wrong
 * account number is money already sent to it.
 */
export async function verifyRefundAccount(params: {
  merchantReference: string;
  accountNumber: string;
  bankCode: string;
}): Promise<RefundAccountDetails> {
  const { status, data } = await callRamp(
    `/refunds/${encodeURIComponent(params.merchantReference)}/verify_account`,
    "POST",
    {
      account_number: params.accountNumber,
      bank_code: params.bankCode,
      currency_code: "ngn",
    },
  );
  const payload = unwrap(status, data, "Could not verify this account");
  const accountName = String(payload.account_name ?? "");
  if (!accountName) throw new QuidaxRampError("Quidax could not verify this account");
  return {
    accountName,
    accountNumber: String(payload.account_number ?? params.accountNumber),
    bankName: String(payload.bank_name ?? ""),
    bankCode: String(payload.bank_code ?? params.bankCode),
  };
}

/**
 * Submits the customer's own bank account as the destination for a refund
 * Quidax already decided to make (their name-mismatch auto-refund). This
 * does not move money itself — it only tells Quidax where to send what
 * they've already committed to sending back.
 */
export async function submitRefundDetails(params: {
  merchantReference: string;
  accountNumber: string;
  bankCode: string;
  accountName: string;
}): Promise<void> {
  const { status, data } = await callRamp(
    `/refunds/${encodeURIComponent(params.merchantReference)}/details`,
    "POST",
    {
      account_number: params.accountNumber,
      bank_code: params.bankCode,
      account_name: params.accountName,
    },
  );
  unwrap(status, data, "Could not submit refund details");
}

export interface OnRampStatus {
  status: string;
  cryptoAmount: number | null;
  txHash: string | null;
  errorMessage: string | null;
}

/**
 * Fetches the latest status of an on-ramp purchase directly — the fallback
 * for when its webhook never arrives (crypto-buy-reconcile). Called with
 * Quidax's OWN `reference` (stored as metadata.quidax_reference on the
 * transaction), not our `merchant_reference` — the path parameter here is
 * literally named `{reference}` in Quidax's docs, unlike confirm's, which is
 * documented as `{merchant_reference}` despite an inconsistent URL example
 * elsewhere in the same doc set. If this guess is wrong for a given account,
 * the failure is just "reconcile finds nothing this round" (a 404, caught by
 * the caller) — never a wrong settlement, since nothing here writes state.
 */
export async function requeryOnRamp(reference: string): Promise<OnRampStatus> {
  const { status, data } = await callRamp(`/on_ramp_transaction/${encodeURIComponent(reference)}`);
  const payload = unwrap(status, data, "Could not fetch this transaction");
  return {
    status: String(payload.status ?? ""),
    cryptoAmount: payload.crypto_payout?.amount != null ? Number(payload.crypto_payout.amount) : null,
    txHash: payload.crypto_payout?.transaction_hash ? String(payload.crypto_payout.transaction_hash) : null,
    errorMessage: payload.error_message != null ? String(payload.error_message) : null,
  };
}

/**
 * A live, real Ramp quote for how much crypto a given Naira amount actually
 * buys right now — Ramp's own pricing, not the exchange's usdtngn ticker
 * (crypto-markets' source for the Buy amount screen's live estimate), which
 * turned out to be running roughly half the real rate: a real ₦3,000
 * purchase settled at ~1.1462 USDT while the ticker-based estimate showed
 * ~2.15208 for the same amount. Only covers usdt/usdc/xaut/usat — the app
 * only ever buys USDT this way, so that's the only asset this is used for;
 * swap-target coins (BTC, ETH, ...) keep using their own <coin>ngn market
 * price, which hasn't shown this same staleness.
 */
export async function getPurchaseQuote(params: {
  fiatAmountNgn: number;
  network: string;
}): Promise<{ toAmount: number; fee: number }> {
  const query = new URLSearchParams({
    currency: "ngn",
    token: "usdt",
    fiat_amount: String(params.fiatAmountNgn),
    token_network: params.network,
  });
  const { status, data } = await callRamp(`/purchase_quotes/buy?${query.toString()}`, "POST");
  const payload = unwrap(status, data, "Could not get a live quote");
  return {
    toAmount: Number(payload.to_amount) || 0,
    fee: Number(payload.fee) || 0,
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
