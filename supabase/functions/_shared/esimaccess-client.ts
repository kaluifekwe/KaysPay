// eSIM Access API — simple header auth (RT-AccessCode), no OAuth/JWT dance.
// IMPORTANT: eSIM Access has no sandbox environment — every call here runs
// against real money in the account balance. Unused, not-yet-downloaded
// orders can be refunded via cancelProfile, but there is no safe "test mode".
const ESIMACCESS_BASE_URL = "https://api.esimaccess.com/api/v1/open";
const ESIMACCESS_ACCESS_CODE = Deno.env.get("ESIMACCESS_ACCESS_CODE");

export class ESIMAccessError extends Error {}

export function isESIMAccessConfigured(): boolean {
  return !!ESIMACCESS_ACCESS_CODE;
}

async function call(path: string, body: Record<string, unknown>): Promise<any> {
  if (!ESIMACCESS_ACCESS_CODE) throw new ESIMAccessError("eSIM Access not configured");

  const res = await fetch(`${ESIMACCESS_BASE_URL}${path}`, {
    method: "POST",
    headers: { "RT-AccessCode": ESIMACCESS_ACCESS_CODE, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

/** POST /package/list — live catalog. `price` is USD * 10,000 (10000 = $1.00). */
export function listESIMAccessPackages(locationCode: string): Promise<any> {
  return call("/package/list", { locationCode, type: "BASE" });
}

/**
 * POST /esim/order — async: returns only an orderNo. The actual eSIM
 * profile (QR code, activation code) takes up to ~30s to allocate and must
 * be fetched separately via queryESIMAccessOrder — same async pattern as
 * VTU.ng's order lifecycle, resolved by a reconcile sweep if not ready yet.
 */
export function orderESIMAccessProfile(
  transactionId: string,
  packageCode: string,
  price: number, // USD * 10,000
): Promise<any> {
  return call("/esim/order", {
    transactionId,
    amount: price,
    packageInfoList: [{ packageCode, count: 1, price }],
  });
}

/** POST /esim/query — fetch the allocated profile (QR code) for an order. */
export function queryESIMAccessOrder(orderNo: string): Promise<any> {
  return call("/esim/query", { orderNo, pager: { pageNum: 1, pageSize: 10 } });
}

/** POST /esim/cancel — refunds an unused, not-yet-downloaded eSIM. */
export function cancelESIMAccessProfile(esimTranNo: string): Promise<any> {
  return call("/esim/cancel", { esimTranNo });
}
