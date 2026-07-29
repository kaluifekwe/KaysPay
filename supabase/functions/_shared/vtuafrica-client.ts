// VTUAfrica v1 API — GET + query-string based (no JSON body, no bearer
// token). The apikey travels as a query param on every call. Now the
// provider for the whole VTU catalog (airtime, data, electricity, TV,
// betting, exam pins).
const VTUAFRICA_API_KEY = Deno.env.get("VTUAFRICA_API_KEY");
const VTUAFRICA_BASE_URL = "https://vtuafrica.com.ng/portal/api";

// VTUAfrica orders are NOT always synchronous. Some services (betting
// funding confirmed, and likely bill-type payments) return an accepted-but-
// unsettled Status like "Processing" — the request went through and OUR
// merchant wallet was charged, it just hasn't finalized. Treating those as
// failures (and refunding the user) is a money leak, so they must be held
// 'pending' and resolved by the reconcile sweep, exactly like VTU.ng orders.
const PENDING_STATUSES = ["processing", "pending", "initiated", "queued", "on hold", "on-hold"];
const FAILURE_STATUSES = ["failed", "refunded", "reversed", "cancelled", "canceled", "declined"];

export class VTUAfricaError extends Error {}

// The apikey rides in the VTUAfrica request URL, so a low-level fetch failure
// (e.g. DNS "Temporary failure in name resolution") throws an Error whose
// message contains the full URL — including the key. Callers persist these
// error strings to transaction metadata (reconcile) which is user-readable via
// RLS, so the key MUST be stripped before it ever leaves this module.
function redactApiKey(s: string): string {
  return s.replace(/apikey=[^&\s)"']+/gi, "apikey=***");
}

export function isVtuAfricaConfigured(): boolean {
  return !!VTUAFRICA_API_KEY;
}

/**
 * Every VTUAfrica response shares the same envelope: {code, description}.
 * code 101 + description.Status "Completed" means success; anything else
 * (including network/auth errors) is a failure — VTUAfrica doesn't document
 * a distinct error-code list, so any non-101/non-Completed is treated
 * uniformly as "did not succeed, refund".
 */
export async function callVTUAfrica(
  endpoint: string,
  params: Record<string, string | number>,
): Promise<any> {
  if (!VTUAFRICA_API_KEY) throw new VTUAfricaError("VTUAfrica API key not configured");

  const query = new URLSearchParams({
    apikey: VTUAFRICA_API_KEY,
    ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
  });

  // Found live 2026-07-06: this fetch had no timeout at all, and VTUAfrica's
  // /merchant-verify (serviceName=Transaction) hangs indefinitely for at
  // least some betting-order refs instead of erroring — which stalled the
  // ENTIRE vtuafrica-reconcile sweep on every run (never returning a
  // response, so pg_net logged nothing and no pending order ever got
  // checked, not just the one that hung). A hard timeout means one bad
  // provider response can only ever cost this one call, never the whole run.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  let res: Response;
  try {
    res = await fetch(`${VTUAFRICA_BASE_URL}${endpoint}/?${query.toString()}`, { signal: controller.signal });
  } catch (e) {
    // Re-throw as a plain Error (NOT VTUAfricaError, so callers still treat a
    // transient network blip as ambiguous/hold-pending, not a config failure)
    // with the apikey stripped out of the message.
    throw new Error(redactApiKey(String((e as Error)?.message ?? e)));
  } finally {
    clearTimeout(timeout);
  }
  const text = await res.text();

  // Some endpoints (confirmed on /merchant-verify) prepend a stray legacy
  // JSON blob before their documented {code,description} response, making
  // the raw body two concatenated JSON objects — not valid JSON on its own.
  // The canonical object always starts with {"code": and is the last such
  // occurrence in the body, so parse from there instead of the raw text.
  const idx = text.lastIndexOf('{"code":');
  const jsonStr = idx >= 0 ? text.slice(idx).trim() : text.trim();
  return JSON.parse(jsonStr);
}

/**
 * Retries a transient network failure (confirmed live 2026-07-06, more than
 * once: a payroll cycle, the reconcile sweep, and a betting funding order
 * all separately hit "dns error: ... Temporary failure in name resolution"
 * reaching VTUAfrica — a blip in the Edge Function's own network, not a real
 * provider decline). callVTUAfrica has no retry of its own, so a single bad
 * moment previously failed a whole payroll cycle, or left a reconcile target
 * stuck for another 5 minutes. Safe to retry broadly: nothing here is a
 * PIN-token flow racing an expiry.
 *
 * 3 attempts with a flat 1.5s delay (the original tuning) turned out not to
 * be enough — a real payroll cycle exhausted all 3 attempts for BOTH of its
 * recipients independently, meaning this DNS issue can outlast ~4.5s.
 * 5 attempts with exponential backoff (1s/2s/4s/8s between tries, ~15s total
 * window) gives a sustained blip much more room to clear before giving up.
 */
export async function callVTUAfricaWithRetry(
  endpoint: string,
  params: Record<string, string | number>,
  attempts = 5,
): Promise<any> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await callVTUAfrica(endpoint, params);
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, i)));
    }
  }
  throw lastErr;
}

export function isVtuAfricaSuccess(result: any): boolean {
  return result?.code === 101 && String(result?.description?.Status ?? "").toLowerCase() === "completed";
}

/**
 * Categorizes a VTUAfrica purchase response at call time.
 * - "success": completed synchronously.
 * - "pending": accepted but not settled (Processing/etc.) — hold, don't refund.
 * - "failed": explicit failure status, or a hard reject (code != 101, e.g.
 *   invalid params / insufficient merchant balance — nothing was charged).
 * - "unknown": code 101 with an unrecognized Status — accepted, so treat as
 *   pending (hold, let reconcile settle it) rather than risk a double outcome.
 */
export function vtuAfricaOutcome(result: any): "success" | "pending" | "failed" | "unknown" {
  const status = String(result?.description?.Status ?? "").trim().toLowerCase();
  if (result?.code === 101 && status === "completed") return "success";
  if (result?.code === 101 && PENDING_STATUSES.includes(status)) return "pending";
  if (FAILURE_STATUSES.includes(status)) return "failed";
  if (result?.code !== 101) return "failed";
  return "unknown";
}

/** True only for an EXPLICIT terminal-failure status word (not a bare
 * code!=101). Used by reconcile so a cross-provider "Does not Exist" query
 * result is never mistaken for a refundable failure. */
export function isVtuAfricaExplicitFailure(result: any): boolean {
  return FAILURE_STATUSES.includes(String(result?.description?.Status ?? "").trim().toLowerCase());
}

/**
 * Queries the settled status of a prior order by reference. VTUAfrica strips
 * non-alphanumerics from the ref it stores (our "ksp_123_abc" becomes
 * "ksp123abc" as its ReferenceID), so the caller's raw idempotency key must
 * be stripped the same way to match.
 */
export function stripRef(ref: string): string {
  return ref.replace(/[^a-zA-Z0-9]/g, "");
}

export function queryVTUAfrica(ref: string): Promise<any> {
  return callVTUAfricaWithRetry("/merchant-verify", { serviceName: "Transaction", ref: stripRef(ref) });
}
