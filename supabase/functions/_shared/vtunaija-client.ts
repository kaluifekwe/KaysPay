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
}

export type VTUNaijaOutcome = "success" | "failed" | "unknown";

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
