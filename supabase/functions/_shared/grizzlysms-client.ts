// GrizzlySMS API — sms-activate-compatible protocol. Plain-text responses
// (not JSON except for getPrices/getCountries), api_key as a query param.
// This is the CUSTOMER-side "Activation API" (buying numbers), not the
// "Partner API" (which is for becoming a number supplier — a different role).
const GRIZZLYSMS_BASE_URL = "https://api.grizzlysms.com/stubs/handler_api.php";
const GRIZZLYSMS_API_KEY = Deno.env.get("GRIZZLYSMS_API_KEY");

export class GrizzlySMSError extends Error {}

export function isGrizzlySMSConfigured(): boolean {
  return !!GRIZZLYSMS_API_KEY;
}

async function call(params: Record<string, string>): Promise<string> {
  if (!GRIZZLYSMS_API_KEY) throw new GrizzlySMSError("GrizzlySMS not configured");

  const query = new URLSearchParams({ api_key: GRIZZLYSMS_API_KEY, ...params });
  const res = await fetch(`${GRIZZLYSMS_BASE_URL}?${query.toString()}`);
  return res.text();
}

/** GET current prices for a specific country — JSON: { [serviceCode]: { count, cost, retry } }. */
export async function getPrices(countryId: string): Promise<Record<string, { count: number; cost: number }>> {
  const text = await call({ action: "getPrices", country: countryId });
  const parsed = JSON.parse(text);
  // Response is nested one level under the country id even when filtered.
  return parsed?.[countryId] || {};
}

/**
 * Rent a number. Plain-text response: "ACCESS_NUMBER:activationId:phoneNumber"
 * on success, or an error code (BAD_KEY, NO_BALANCE, NO_NUMBERS, ...).
 */
export async function getNumber(
  service: string,
  countryId: string,
  maxPrice: number, // USD — same currency as getPrices' "cost" field
): Promise<{ activationId: string; phoneNumber: string } | { error: string }> {
  const text = await call({ action: "getNumber", service, country: countryId, maxPrice: String(maxPrice) });
  if (text.startsWith("ACCESS_NUMBER:")) {
    const [, activationId, phoneNumber] = text.split(":");
    return { activationId, phoneNumber };
  }
  return { error: text.trim() };
}

// Status responses: STATUS_WAIT_CODE (waiting), STATUS_WAIT_RETRY:$lastcode,
// STATUS_WAIT_RESEND, STATUS_CANCEL, STATUS_OK:$code (code received).
export async function getStatus(activationId: string): Promise<{ status: string; code?: string }> {
  const text = await call({ action: "getStatus", id: activationId });
  if (text.startsWith("STATUS_OK:")) {
    return { status: "STATUS_OK", code: text.split(":")[1] };
  }
  if (text.startsWith("STATUS_WAIT_RETRY:")) {
    return { status: "STATUS_WAIT_RETRY", code: text.split(":")[1] };
  }
  return { status: text.trim() };
}

// setStatus values: -1/8 = cancel, 1 = inform ready, 3 = request next code,
// 6 = complete activation (finalize after receiving the code).
export async function setStatus(activationId: string, status: number): Promise<string> {
  return call({ action: "setStatus", id: activationId, status: String(status) });
}
