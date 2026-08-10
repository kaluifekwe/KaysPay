// VTUnaija — simple header-token API (no login/JWT flow, unlike VTU.ng).
// Confirmed live from the owner's own dashboard docs, 2026-07-30: purchase
// endpoints (airtime /topup/, data /internetbundles/) share one response
// envelope, and NO async/pending state is documented anywhere for either —
// every example given is a clean success or fail. That's DIFFERENT from both
// VTU.ng and VTUAfrica, which both have genuine async "processing" orders.
const VTUNAIJA_API_KEY = Deno.env.get("VTUNAIJA_API_KEY");
const VTUNAIJA_BASE_URL = "https://vtunaija.com.ng/api";

export class VTUNaijaError extends Error {}

export function isVtuNaijaConfigured(): boolean {
  return !!VTUNAIJA_API_KEY;
}

export interface NormalizedVTUNaijaResult {
  // true = explicit success, false = explicit failure, null = neither
  // vocabulary matched (malformed/unexpected shape) — never guessed.
  statusOk: boolean | null;
  message: string;
  id: string | null;
  ident: string | null;
  planAmount: string | null;
  pin: string | null;
  serial: string | null;
}

export type VTUNaijaOutcome = "success" | "failed" | "unknown";

export interface NormalizedVTUNaijaQueryResult {
  outcome: VTUNaijaOutcome;
  transactionId: string | null;
  transactionType: string | null;
  size: string | null;
  network: string | null;
  message: string;
}

/**
 * Calls a VTUnaija endpoint with the account's API token. Purchase/catalog
 * endpoints are POST with a JSON body; the queryTransaction/queryDataTransaction
 * endpoints are GET with the identifier in the query string (per their own
 * docs) — `method` defaults to POST since that's every purchase call site.
 *
 * No retry wrapper here, by design — unlike VTUAfrica's transient-DNS-blip
 * retries, VTUnaija's request-id idempotency on a resubmitted PURCHASE call is
 * unconfirmed, so a single ambiguous attempt is classified via
 * vtunaijaOutcome()/caught by the caller and left for the reconcile sweep to
 * resolve via a QUERY endpoint — never by blindly resubmitting the purchase.
 */
export async function callVTUNaija(
  endpoint: string,
  body: Record<string, unknown>,
  timeoutMs = 20000,
  method: "POST" | "GET" = "POST",
): Promise<any> {
  if (!VTUNAIJA_API_KEY) throw new VTUNaijaError("VTUnaija API key not configured");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${VTUNAIJA_BASE_URL}${endpoint}`, {
      method,
      headers: {
        Authorization: `Token ${VTUNAIJA_API_KEY}`,
        "Content-Type": "application/json",
      },
      ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
  } catch (e) {
    // Network-level failure (DNS, connection reset, timeout via abort) — the
    // token never rides in the URL here (unlike VTUAfrica), so no redaction
    // is needed, but re-throw as a plain Error so callers treat this as
    // ambiguous (may have reached VTUnaija) rather than a config fault.
    throw new Error(String((e as Error)?.message ?? e));
  } finally {
    clearTimeout(timeout);
  }

  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    // Malformed body is exactly the ambiguous case too — never assume success
    // or failure from unparseable text.
    throw new Error("VTUnaija returned a non-JSON response");
  }
}

/**
 * Handles the two key-naming variants seen in VTUnaija's own docs: purchase
 * responses use `api_response` for the human message, but validation/auth
 * error responses use `message` instead. Both `Status` (capitalized,
 * "successful"/"failed") and `status` (lowercase, "success"/"fail") are
 * checked — anything not matching either vocabulary stays null, not guessed.
 */
export function normalizeVTUNaijaResult(result: any): NormalizedVTUNaijaResult {
  const rawStatusCap = String(result?.Status ?? "").trim().toLowerCase();
  const rawStatusLower = String(result?.status ?? "").trim().toLowerCase();
  const statusOk =
    rawStatusCap === "successful" || rawStatusLower === "success" ? true :
    rawStatusCap === "failed" || rawStatusLower === "fail" ? false :
    null;

  return {
    statusOk,
    message: String(result?.api_response ?? result?.message ?? "").trim(),
    id: result?.id != null ? String(result.id) : null,
    ident: result?.ident != null ? String(result.ident) : null,
    planAmount: result?.plan_amount != null ? String(result.plan_amount) : null,
    pin: result?.pin != null ? String(result.pin).trim() || null : null,
    serial: result?.serial != null ? String(result.serial).trim() || null : null,
  };
}

/**
 * No "pending" bucket exists here (unlike vtuAfricaOutcome) because VTUnaija
 * documents no async state for airtime/data — but "unknown" plays the exact
 * same safety role: anything that isn't an explicit success or explicit
 * failure is held pending and settled later via the query endpoints below,
 * never assumed either way.
 */
export function vtunaijaOutcome(result: any): VTUNaijaOutcome {
  const { statusOk } = normalizeVTUNaijaResult(result);
  if (statusOk === true) return "success";
  if (statusOk === false) return "failed";
  return "unknown";
}

/**
 * Query endpoints have two different status layers:
 * - top-level status: whether VTUnaija successfully retrieved the record;
 * - data.status: whether the underlying customer transaction succeeded.
 *
 * Never use the top-level retrieval status to settle money. A successful
 * lookup can contain a failed transaction. Unexpected/missing nested data is
 * deliberately "unknown" so reconciliation leaves the wallet untouched.
 */
export function normalizeVTUNaijaQueryResult(result: any): NormalizedVTUNaijaQueryResult {
  const retrievalStatusCap = String(result?.Status ?? "").trim().toLowerCase();
  const retrievalStatusLower = String(result?.status ?? "").trim().toLowerCase();
  const retrievalSucceeded =
    retrievalStatusCap === "successful" || retrievalStatusLower === "success";
  const data = retrievalSucceeded && result?.data && typeof result.data === "object"
    ? result.data
    : null;

  const transactionStatus = String(data?.status ?? "").trim().toLowerCase();
  const outcome: VTUNaijaOutcome =
    transactionStatus === "successful" || transactionStatus === "success" ? "success" :
    transactionStatus === "failed" || transactionStatus === "fail" ? "failed" :
    "unknown";

  const value = (input: unknown): string | null => {
    if (input === null || input === undefined) return null;
    const text = String(input).trim();
    return text || null;
  };

  return {
    outcome,
    transactionId: value(data?.transaction_id),
    transactionType: value(data?.transaction_type),
    size: value(data?.size),
    network: value(data?.network),
    message: value(data?.api_response) ?? value(data?.description) ?? value(result?.message) ?? "",
  };
}

/**
 * Settles an ambiguous airtime order by querying VTUnaija's own record of it —
 * used only by reconcile/on-demand-verify logic, NEVER by the purchase path
 * (which must not resubmit /topup/ itself; see callVTUNaija's docstring).
 */
export function queryVTUNaijaTransaction(transactionId: string): Promise<any> {
  return callVTUNaija(
    `/queryTransaction/index.php?transaction_id=${encodeURIComponent(transactionId)}`,
    {},
    20000,
    "GET",
  );
}

/** Same as queryVTUNaijaTransaction, but for data-bundle orders (VTUnaija uses a distinct endpoint + query param for these). */
export function queryVTUNaijaDataTransaction(datarequestId: string): Promise<any> {
  return callVTUNaija(
    `/queryDataTransaction/index.php?datarequest_id=${encodeURIComponent(datarequestId)}`,
    {},
    20000,
    "GET",
  );
}

/**
 * Verifies a meter number against a DISCO BEFORE payment, returning the real
 * customer name (and address) tied to that meter — lets the caller confirm
 * they're paying the right account before any money moves. Read-only; safe
 * to call as often as needed, never mutates anything on VTUnaija's side.
 */
export function verifyElectricityMeter(discoName: string, meterNumber: string): Promise<any> {
  return callVTUNaija("/billpayment/verify/", {
    disco_name: discoName,
    meter_number: meterNumber,
  });
}

export interface ElectricityMeterVerification {
  ok: boolean;
  customerName: string | null;
  customerAddress: string | null;
}

/**
 * The verify endpoint's failure vocabulary isn't confirmed the same way
 * purchase responses are (no live failed example seen yet) — so a non-empty
 * Customer_Name is treated as the only trustworthy success signal, same
 * "never guess" discipline as normalizeVTUNaijaResult above. Anything else
 * (empty name, malformed shape, provider error) is just "not verified."
 */
export function normalizeElectricityMeterVerification(result: any): ElectricityMeterVerification {
  const rawName = typeof result?.Customer_Name === "string" ? result.Customer_Name.trim() : "";
  const name = rawName ? normalizeVerifiedCustomerName(rawName) : "";
  const address = typeof result?.Customer_Address === "string" ? result.Customer_Address.trim() : "";
  return {
    ok: name.length > 0,
    customerName: name || null,
    customerAddress: address || null,
  };
}

/** Read-only verification of a GOtv/DStv/StarTimes smart-card or IUC number. */
export function verifyCableTVSmartcard(cableName: string, smartcardNumber: string): Promise<any> {
  return callVTUNaija("/cablesub/verify/", {
    cablename: cableName,
    smart_card_number: smartcardNumber,
  });
}

export interface CableTVSmartcardVerification {
  ok: boolean;
  customerName: string | null;
  accountStatus: string | null;
  dueDate: string | null;
  currentBouquet: string | null;
  renewalAmount: number | null;
}

// Some provider verification responses repeat the complete customer name
// (for example "Humble Humble" or "John Doe John Doe"). Keep the raw value
// server-side for audit, but use this normalized form for display/receipts.
export function normalizeVerifiedCustomerName(value: string): string {
  const words = value.trim().replace(/\s+/g, " ").split(" ");
  if (words.length < 2) return words.join(" ");
  for (let half = 1; half <= Math.floor(words.length / 2); half += 1) {
    if (half * 2 !== words.length) continue;
    const first = words.slice(0, half).join(" ");
    const second = words.slice(half).join(" ");
    if (first.localeCompare(second, undefined, { sensitivity: "accent" }) === 0) return first;
  }
  return words.join(" ");
}

/**
 * Treat a non-empty customer name as the trustworthy success signal. The
 * provider documents both Customer_Name/name and sometimes nests the extra
 * account fields inside Full_Details, so accept either documented shape.
 */
export function normalizeCableTVSmartcardVerification(result: any): CableTVSmartcardVerification {
  const parseDetails = (value: unknown): Record<string, unknown> => {
    let current = value;
    for (let depth = 0; depth < 2; depth += 1) {
      if (Array.isArray(current)) current = current[0];
      if (current && typeof current === "object") return current as Record<string, unknown>;
      if (typeof current !== "string" || current.length > 10_000) return {};
      try {
        current = JSON.parse(current);
      } catch {
        const source = String(current).trim();
        const extracted: Record<string, string> = {};
        for (const key of ["Customer_Name", "Status", "Status_Name", "Due_Date", "Current_Bouquet", "Renewal_Amount"]) {
          const safeKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const pattern = new RegExp(
            `(?:^|[,{}])\\s*["']?${safeKey}["']?\\s*:\\s*(?:["']([^"']{1,200})["']|([^,}\\r\\n]{1,200}))`,
            "i",
          );
          const match = source.match(pattern);
          const found = (match?.[1] ?? match?.[2] ?? "").trim();
          if (found) extracted[key] = found;
        }
        return extracted;
      }
    }
    return {};
  };
  const details = parseDetails(result?.Full_Details ?? result?.full_details ?? result?.details);
  const detail = (...keys: string[]): unknown => {
    for (const key of keys) {
      const match = Object.keys(details).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
      if (match) return details[match];
    }
    return undefined;
  };
  const text = (value: unknown): string | null => {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed ? trimmed.slice(0, 200) : null;
  };
  const rawCustomerName = text(result?.Customer_Name) ?? text(result?.name) ?? text(detail("Customer_Name", "customerName", "name"));
  const customerName = rawCustomerName ? normalizeVerifiedCustomerName(rawCustomerName) : null;
  const renewalRaw = Number(result?.Renewal_Amount ?? result?.renewal_amount ?? detail("Renewal_Amount", "renewalAmount"));
  return {
    ok: customerName !== null,
    customerName,
    accountStatus: text(result?.Status_Name) ?? text(result?.account_status) ?? text(detail("Status", "Status_Name", "accountStatus")),
    dueDate: text(result?.Due_Date) ?? text(result?.due_date) ?? text(detail("Due_Date", "dueDate")),
    currentBouquet: text(result?.Current_Bouquet) ?? text(result?.current_bouquet) ?? text(detail("Current_Bouquet", "currentBouquet")),
    renewalAmount: Number.isFinite(renewalRaw) && renewalRaw >= 0 ? renewalRaw : null,
  };
}
