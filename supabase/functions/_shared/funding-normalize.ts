import type { FundingCandidate } from "./funding-credit.ts";

function timestamp(value: unknown): string | null {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

export function normalizePaystackFunding(record: any): FundingCandidate | null {
  const authorization = record?.authorization;
  const channel = String(authorization?.channel ?? record?.channel ?? "").toLowerCase();
  const accountNumber = authorization?.receiver_bank_account_number;
  const amountKobo = Number(record?.amount);
  if (
    String(record?.status || "").toLowerCase() !== "success" ||
    channel !== "dedicated_nuban" || !accountNumber || !record?.reference ||
    !Number.isSafeInteger(amountKobo) || amountKobo <= 0 ||
    String(record?.currency || "NGN").toUpperCase() !== "NGN"
  ) return null;
  return {
    provider: "paystack",
    reference: String(record.reference),
    transactionId: record?.id != null ? String(record.id) : null,
    amountKobo,
    currency: "NGN",
    accountNumber: String(accountNumber),
    customerCode: record?.customer?.customer_code ? String(record.customer.customer_code) : null,
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
