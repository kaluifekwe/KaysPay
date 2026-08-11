import type { FundingCandidate } from "./funding-credit.ts";

function timestamp(value: unknown): string | null {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

export function normalizePaystackFunding(record: any): FundingCandidate | null {
  const authorization = record?.authorization;
  const channel = String(authorization?.channel ?? record?.channel ?? "").toLowerCase();
  // Only the WEBHOOK payload carries receiver_bank_account_number. Paystack's
  // list-transactions response (the only thing the reconciliation sweep can
  // read) returns a card-shaped authorization object without it, so requiring
  // it here silently discarded every real transfer and left the sweep
  // reporting success while crediting nothing. Verified against the live API:
  // authorization contains [authorization_code, bin, last4, exp_month,
  // exp_year, channel, card_type, bank, country_code, brand, reusable,
  // signature, account_name] — no receiver account. customer_code IS present
  // and maps to virtual_accounts, so it is the reliable owner identifier here.
  const accountNumber = authorization?.receiver_bank_account_number ?? null;
  const customerCode = record?.customer?.customer_code ?? null;
  const amountKobo = Number(record?.amount);
  if (
    String(record?.status || "").toLowerCase() !== "success" ||
    // Kept: this is what stops a card payment being credited as a transfer,
    // and the list response does include the channel.
    channel !== "dedicated_nuban" ||
    // At least one identifier must be present to attribute the money.
    (!accountNumber && !customerCode) ||
    !record?.reference ||
    !Number.isSafeInteger(amountKobo) || amountKobo <= 0 ||
    String(record?.currency || "NGN").toUpperCase() !== "NGN"
  ) return null;
  return {
    provider: "paystack",
    reference: String(record.reference),
    transactionId: record?.id != null ? String(record.id) : null,
    amountKobo,
    currency: "NGN",
    accountNumber: accountNumber ? String(accountNumber) : null,
    customerCode: customerCode ? String(customerCode) : null,
    providerCreatedAt: timestamp(record?.paid_at ?? record?.created_at),
    source: "reconcile",
  };
}

export function normalizeFlutterwaveFunding(record: any): FundingCandidate | null {
  const status = String(record?.status || "").toLowerCase();
  const paymentType = String(record?.payment_method_details?.type ?? record?.payment_type ?? "").toLowerCase();
  const virtualAccountId = record?.virtual_account_id ??
    record?.payment_method_details?.bank_transfer?.virtual_account_id ?? null;
  const customerCode = typeof record?.customer === "string"
    ? record.customer
    : record?.customer?.id ?? record?.customer_id;
  const amount = Number(record?.amount);
  const amountKobo = Math.round(amount * 100);
  if (
    status !== "succeeded" || !record?.id || !customerCode ||
    (!virtualAccountId && paymentType !== "bank_transfer") ||
    !Number.isFinite(amount) || amount <= 0 || !Number.isSafeInteger(amountKobo) ||
    String(record?.currency || "").toUpperCase() !== "NGN"
  ) return null;
  return {
    provider: "flutterwave",
    reference: String(record.id), transactionId: String(record.id), amountKobo, currency: "NGN",
    customerCode: String(customerCode),
    virtualAccountId: virtualAccountId ? String(virtualAccountId) : null,
    providerCreatedAt: timestamp(record?.created_datetime), source: "reconcile",
  };
}
