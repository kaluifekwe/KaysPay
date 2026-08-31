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
): Promise<{ status: number; data: any; headers: Headers }> {
  if (!QUIDAX_SECRET_KEY) throw new QuidaxError("Crypto service not configured");

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
    data = { status: "error", message: "Unexpected response from crypto service" };
  }
  return { status: response.status, data, headers: response.headers };
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
    throw new QuidaxError(data?.message || "Could not set up your crypto account", status);
  }
  return { id: data.data.id, sn: data.data.sn, email: data.data.email };
}

/**
 * All sub-accounts under this merchant, across every page — used only to
 * recover an orphaned sub-account (see createSubAccount's doc comment),
 * never on the normal path. Quidax paginates this via response HEADERS
 * (x-next-page/x-total-pages), not a body field, and caps at 100/page — a
 * single unpaginated call would silently miss anything past the first page.
 */
export async function getSubAccounts(): Promise<QuidaxSubAccount[]> {
  const results: QuidaxSubAccount[] = [];
  let page = 1;
  for (let guard = 0; guard < 50; guard++) {
    const { status, data, headers } = await callQuidax(`/users?per_page=100&page=${page}`, "GET");
    if (status >= 400 || data?.status !== "success") {
      throw new QuidaxError(data?.message || "Could not list crypto accounts", status);
    }
    results.push(...(data.data as any[]).map((u) => ({ id: String(u.id), sn: String(u.sn), email: String(u.email) })));
    const nextPage = headers.get("x-next-page");
    if (!nextPage) break;
    page = Number(nextPage);
    if (!Number.isFinite(page) || page <= 0) break;
  }
  return results;
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
    throw new QuidaxError(data?.message || "Could not fetch your crypto balances", status);
  }
  return (data.data as any[]).map((w) => ({
    currency: String(w.currency),
    balance: String(w.balance),
    locked: String(w.locked),
    isCrypto: !!w.is_crypto,
    depositAddress: w.deposit_address ?? null,
  }));
}

export interface QuidaxWithdrawalFee {
  fee: number;
  type: string;
}

/**
 * Quidax's live fee calculation for a concrete withdrawal amount/network.
 * Fees are provider-controlled and can change, so financial validation must
 * call this endpoint rather than hardcode today's TRC20 value in KaysPay.
 */
export async function getCryptoWithdrawalFee(params: {
  currency: string;
  amount: number;
  network: string;
}): Promise<QuidaxWithdrawalFee> {
  const query = new URLSearchParams({
    currency: params.currency.toLowerCase(),
    amount: String(params.amount),
    network: params.network.toLowerCase(),
  });
  const { status, data } = await callQuidax(`/users/me/fee_rule?${query.toString()}`, "GET");
  if (status >= 400 || data?.status !== "success") {
    throw new QuidaxError(data?.message || "Could not calculate the network fee", status);
  }
  const fee = Number(data?.data?.fee);
  if (!Number.isFinite(fee) || fee < 0) {
    throw new QuidaxError("Could not calculate the network fee");
  }
  return { fee, type: String(data?.data?.type || "flat") };
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
  if (!addr) throw new QuidaxError("Could not generate a deposit address");
  return {
    id: String(data.data.id),
    currency: String(data.data.currency),
    network: String(data.data.network ?? params.network),
    address: String(addr),
  };
}

export interface QuidaxTicker {
  /** Last traded price. */
  last: number;
  /** Best bid — what the market pays you when SELLING into it. */
  bid: number;
  /** Best ask — what you pay the market when BUYING from it. */
  ask: number;
}

export interface QuidaxFullTicker extends QuidaxTicker {
  /** Price 24h ago — absent for thin/illiquid pairs, per Quidax's own docs. */
  open: number | null;
  low: number | null;
  high: number | null;
}

/**
 * Every market's ticker in one call — confirmed shape from Quidax's own
 * "List Market Tickers" reference (docs.quidax.io/reference/list-market-
 * tickers): `{ <market>: { ticker: { buy, sell, last, low, high, open, vol },
 * at } }`. Thin markets can omit fields other than buy/sell, so every read
 * here tolerates a missing value rather than assuming the full set.
 */
export async function getAllMarketTickers(): Promise<Record<string, QuidaxFullTicker>> {
  const { status, data } = await callQuidax(`/markets/tickers`, "GET");
  if (status >= 400 || data?.status !== "success") {
    throw new QuidaxError(data?.message || "Could not fetch market prices", status);
  }
  const out: Record<string, QuidaxFullTicker> = {};
  for (const [market, entry] of Object.entries<any>(data.data ?? {})) {
    const ticker = entry?.ticker;
    const last = Number(ticker?.last);
    if (!Number.isFinite(last) || last <= 0) continue;
    const bid = Number(ticker?.buy);
    const ask = Number(ticker?.sell);
    const open = Number(ticker?.open);
    const low = Number(ticker?.low);
    const high = Number(ticker?.high);
    out[market] = {
      last,
      bid: Number.isFinite(bid) && bid > 0 ? bid : last,
      ask: Number.isFinite(ask) && ask > 0 ? ask : last,
      open: Number.isFinite(open) && open > 0 ? open : null,
      low: Number.isFinite(low) && low > 0 ? low : null,
      high: Number.isFinite(high) && high > 0 ? high : null,
    };
  }
  return out;
}

/**
 * Live market price for a pair (e.g. "usdtngn"), straight from Quidax's own
 * order book. This is the real crypto market rate — deliberately NOT the
 * interbank USD/NGN feed in _shared/esim-catalog.ts, which is a once-daily
 * bank rate built for eSIM pricing and sits well below what USDT actually
 * trades at in Nigeria. Pricing crypto off that feed sold USDT below market.
 */
export async function getMarketTicker(market: string): Promise<QuidaxTicker> {
  const { status, data } = await callQuidax(`/markets/tickers/${encodeURIComponent(market)}`, "GET");
  if (status >= 400 || data?.status !== "success") {
    throw new QuidaxError(data?.message || "Could not fetch the market price", status);
  }
  // Response is keyed by the market name: data.data.usdtngn.ticker
  const ticker = data.data?.[market]?.ticker ?? data.data?.ticker;
  const last = Number(ticker?.last);
  const bid = Number(ticker?.buy);
  const ask = Number(ticker?.sell);
  if (!Number.isFinite(last) || last <= 0) {
    throw new QuidaxError("No price currently available for " + market);
  }
  return {
    last,
    bid: Number.isFinite(bid) && bid > 0 ? bid : last,
    ask: Number.isFinite(ask) && ask > 0 ? ask : last,
  };
}

/** The merchant's own (parent) account. Its id doubles as the `fund_uid`
 * for internal sub-account -> main transfers. */
export async function getParentAccount(): Promise<QuidaxSubAccount> {
  const { status, data } = await callQuidax("/users/me", "GET");
  if (status >= 400 || data?.status !== "success") {
    throw new QuidaxError(data?.message || "Could not fetch merchant account", status);
  }
  return { id: String(data.data.id), sn: String(data.data.sn), email: String(data.data.email) };
}

export interface QuidaxSwapQuotation {
  id: string;
  fromAmount: string;
  toAmount: string;
  quotedPrice: string;
}

/**
 * Prices a swap on a sub-account's own balance. The quote is only valid for
 * ~15 seconds, so confirmSwapQuotation must follow immediately — never
 * quote on one request and confirm on a later one.
 */
export async function createSwapQuotation(params: {
  quidaxUserId: string;
  fromCurrency: string;
  toCurrency: string;
  fromAmount: string;
}): Promise<QuidaxSwapQuotation> {
  const { status, data } = await callQuidax(
    `/users/${encodeURIComponent(params.quidaxUserId)}/swap_quotation`,
    "POST",
    {
      from_currency: params.fromCurrency,
      to_currency: params.toCurrency,
      from_amount: params.fromAmount,
    },
  );
  if (status >= 400 || data?.status !== "success") {
    throw new QuidaxError(data?.message || "Could not price this swap", status);
  }
  return {
    id: String(data.data.id),
    fromAmount: String(data.data.from_amount),
    toAmount: String(data.data.to_amount),
    quotedPrice: String(data.data.quoted_price),
  };
}

export interface QuidaxSwapTransaction {
  id: string;
  status: string;
  receivedAmount: string | null;
}

/** Executes a quotation. Comes back "initiated" — the swap settles
 * asynchronously and is confirmed by the swap_transaction.complete webhook. */
export async function confirmSwapQuotation(params: {
  quidaxUserId: string;
  quotationId: string;
}): Promise<QuidaxSwapTransaction> {
  const { status, data } = await callQuidax(
    `/users/${encodeURIComponent(params.quidaxUserId)}/swap_quotation/${encodeURIComponent(params.quotationId)}/confirm`,
    "POST",
  );
  if (status >= 400 || data?.status !== "success") {
    throw new QuidaxError(data?.message || "Could not complete this swap", status);
  }
  return {
    id: String(data.data.id),
    status: String(data.data.status),
    receivedAmount: data.data.received_amount != null ? String(data.data.received_amount) : null,
  };
}

export interface QuidaxSwapTransactionListItem extends QuidaxSwapTransaction {
  /** The ORIGINAL quotation id (what createSwapQuotation returns, and what
   * we store as metadata.quidax_swap_id) — distinct from `id` above, which
   * is a separate id confirmSwapQuotation's response creates for the
   * resulting transaction. crypto-sell only ever stores the quotation id,
   * so matching against THIS field (not `id`) is what actually finds a
   * transaction by what we have on hand — same field the webhook handler
   * already prefers (data.swap_quotation.id) when matching a delivery. */
  quotationId: string;
}

/**
 * Lists a sub-account's swap history — the fallback for when a
 * swap_transaction.complete/.failed webhook never arrives (a signature
 * mismatch, a dropped delivery). Deliberately NOT a fetch-by-id: Quidax's
 * GET /swap_transactions/{id} wants the confirm-response's own transaction
 * id, which crypto-sell never captures or stores — only the quotation id
 * is on hand, so this lists recent transactions and the caller matches on
 * quotationId instead.
 */
export async function listSwapTransactions(quidaxUserId: string): Promise<QuidaxSwapTransactionListItem[]> {
  const { status, data } = await callQuidax(`/users/${encodeURIComponent(quidaxUserId)}/swap_transactions`);
  if (status >= 400 || data?.status !== "success") {
    throw new QuidaxError(data?.message || "Could not fetch swap history", status);
  }
  return (data.data ?? []).map((t: any) => ({
    id: String(t.id),
    status: String(t.status),
    receivedAmount: t.received_amount != null ? String(t.received_amount) : null,
    quotationId: String(t.swap_quotation?.id ?? ""),
  }));
}

/**
 * Moves funds out of a sub-account. `fundUid` is either an external
 * blockchain address (a real withdrawal) or another Quidax account id (an
 * internal transfer — that's how sub-account -> main sweeps work). Settles
 * asynchronously via the withdraw.successful / withdraw.rejected webhooks,
 * matched on `reference`, which must be unique per withdrawal.
 */
export async function createWithdrawal(params: {
  quidaxUserId: string;
  currency: string;
  amount: string;
  fundUid: string;
  reference: string;
  network?: string;
  narration?: string;
}): Promise<{ id: string; status: string; fee: string | null }> {
  const { status, data } = await callQuidax(
    `/users/${encodeURIComponent(params.quidaxUserId)}/withdraws`,
    "POST",
    {
      currency: params.currency,
      amount: params.amount,
      fund_uid: params.fundUid,
      reference: params.reference,
      ...(params.network ? { network: params.network } : {}),
      ...(params.narration ? { narration: params.narration } : {}),
    },
  );
  if (status >= 400 || data?.status !== "success") {
    throw new QuidaxError(data?.message || "Could not start this withdrawal", status);
  }
  return {
    id: String(data.data.id),
    status: String(data.data.status),
    fee: data.data.fee != null ? String(data.data.fee) : null,
  };
}

export interface QuidaxBank {
  code: string;
  name: string;
}

/**
 * The exchange API's own NG bank list. Used for the Ramp refund flow's bank
 * picker — deliberately NOT transfer-banks (Flutterwave's list), since
 * Flutterwave and Quidax use different bank code schemes and a refund
 * submitted with the wrong provider's code would resolve to the wrong bank.
 */
export async function listBanks(): Promise<QuidaxBank[]> {
  const { status, data } = await callQuidax("/banks");
  if (status >= 400 || data?.status !== "success") {
    throw new QuidaxError(data?.message || "Could not load the bank list", status);
  }
  return (data.data ?? [])
    .map((b: any) => ({ code: String(b.code ?? ""), name: String(b.name ?? "") }))
    .filter((b: QuidaxBank) => b.code && b.name);
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
  if (!QUIDAX_WEBHOOK_SECRET) {
    console.error("quidax-client: webhook signature check skipped — QUIDAX_WEBHOOK_SECRET not set");
    return false;
  }
  if (!signatureHeader) {
    console.error("quidax-client: webhook signature check failed — no quidax-signature header on the request");
    return false;
  }

  const parts = Object.fromEntries(
    signatureHeader.split(",").map((seg) => {
      const [key, value] = seg.split("=");
      return [key?.trim(), value?.trim()];
    }),
  );
  const timestamp = parts["t"];
  const signature = parts["s"];
  if (!timestamp || !signature) {
    // Diagnostic only — logs the header's shape (keys present, rough
    // length), never anything secret. A real signature failed here once
    // with no further detail available; this is so the next one is
    // actually diagnosable instead of just "failed".
    console.error(
      "quidax-client: webhook signature check failed — could not parse t=/s= from header. Raw keys seen:",
      Object.keys(parts).join(","),
      "header length:",
      signatureHeader.length,
    );
    return false;
  }

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

  if (expected.length !== signature.length) {
    console.error(
      `quidax-client: webhook signature length mismatch — expected ${expected.length} chars, got ${signature.length}. ` +
      `timestamp=${timestamp} (age ${Math.round(Date.now() / 1000 - Number(timestamp))}s), body length=${rawBody.length}`,
    );
    return false;
  }
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  if (diff !== 0) {
    console.error(
      `quidax-client: webhook signature content mismatch — same length, different value. ` +
      `timestamp=${timestamp} (age ${Math.round(Date.now() / 1000 - Number(timestamp))}s), body length=${rawBody.length}, ` +
      `expected[0:8]=${expected.slice(0, 8)}, got[0:8]=${signature.slice(0, 8)}`,
    );
  }
  return diff === 0;
}
