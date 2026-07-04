// VTUAfrica v1 API — GET + query-string based (no JSON body, no bearer
// token). The apikey travels as a query param on every call. Used only for
// services VTU.ng can't cover: betting funding, and Glo data (VTU.ng has no
// available Glo data plans at all).
const VTUAFRICA_API_KEY = Deno.env.get("VTUAFRICA_API_KEY");
const VTUAFRICA_BASE_URL = "https://vtuafrica.com.ng/portal/api";

export class VTUAfricaError extends Error {}

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

  const res = await fetch(`${VTUAFRICA_BASE_URL}${endpoint}/?${query.toString()}`);
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

export function isVtuAfricaSuccess(result: any): boolean {
  return result?.code === 101 && result?.description?.Status === "Completed";
}
