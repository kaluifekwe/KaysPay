// SMSPVA client — REST/JSON API (single endpoint `priemnik.php`, `metod`
// params, apikey). Real-SIM numbers. SMSPVA charges only ON SUCCESS (when the
// SMS actually arrives), so renting a number that never gets a code costs us
// nothing — the user is fully refunded and we lose nothing. Server-only.
import { fetchWithTimeout } from "./provider-fetch.ts";

const BASE = "https://smspva.com/priemnik.php";
const KEY = Deno.env.get("SMSPVA_API_KEY");

export class SmspvaError extends Error {}

export function isSmspvaConfigured(): boolean {
  return !!KEY;
}

async function call(params: Record<string, string>): Promise<any> {
  if (!KEY) throw new SmspvaError("SMSPVA not configured");
  const q = new URLSearchParams({ apikey: KEY, ...params });
  const res = await fetchWithTimeout(`${BASE}?${q.toString()}`, {}, 15_000);
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { response: "error", error_msg: text.slice(0, 200) }; }
}

/** Account balance in USD (SMSPVA prepaid). Null if it couldn't be read. */
export async function getBalance(): Promise<number | null> {
  const data = await call({ metod: "get_balance", service: "opt1" });
  const b = Number(data?.balance);
  return Number.isFinite(b) ? b : null;
}

/** Current USD price for a service in a country, or null if not offered. */
export async function getServicePriceUSD(service: string, country: string): Promise<number | null> {
  const data = await call({ metod: "get_prices", country });
  if (!Array.isArray(data)) return null;
  const entry = data.find((x: any) => x?.Service === service);
  const p = entry ? Number(entry.Price) : NaN;
  return Number.isFinite(p) ? p : null;
}

/**
 * All service prices (USD) for a country in ONE call — {serviceCode: price}.
 * Used by the catalog-sync cron to build the price cache so the app doesn't
 * have to hit SMSPVA live on every service tap.
 */
export async function getCountryPrices(country: string): Promise<Record<string, number>> {
  const data = await call({ metod: "get_prices", country });
  const out: Record<string, number> = {};
  if (Array.isArray(data)) {
    for (const x of data) {
      const p = Number(x?.Price);
      if (x?.Service && Number.isFinite(p)) out[String(x.Service)] = p;
    }
  }
  return out;
}

/** How many numbers are in stock for a service in a country. */
export async function getAvailability(service: string, country: string): Promise<number> {
  const data = await call({ metod: "get_count_new", service, country });
  const n = Number(data?.online);
  return Number.isFinite(n) ? n : 0;
}

/**
 * For a service, which of the given countries have stock right now and at
 * what USD cost — runs the checks in parallel across countries.
 */
export async function getServiceCountries(
  service: string,
  countries: string[],
): Promise<Record<string, { count: number; cost: number }>> {
  const out: Record<string, { count: number; cost: number }> = {};
  // SMSPVA rate-limits bursts, so process in small concurrency-limited batches
  // with a short pause between them rather than firing all ~46 × 2 calls at
  // once (which gets throttled and silently drops valid countries).
  const BATCH = 8;
  for (let i = 0; i < countries.length; i += BATCH) {
    const slice = countries.slice(i, i + BATCH);
    await Promise.all(
      slice.map(async (c) => {
        try {
          const [count, priceList] = await Promise.all([
            getAvailability(service, c),
            call({ metod: "get_prices", country: c }),
          ]);
          if (count > 0 && Array.isArray(priceList)) {
            const entry = priceList.find((x: any) => x?.Service === service);
            const cost = entry ? Number(entry.Price) : NaN;
            if (Number.isFinite(cost)) out[c] = { count, cost };
          }
        } catch { /* skip this country on error */ }
      }),
    );
    if (i + BATCH < countries.length) await new Promise((r) => setTimeout(r, 150));
  }
  return out;
}

/**
 * Rent a number. Returns the activation id + the full E.164 phone number
 * (SMSPVA gives the local number and country code separately). Charged only
 * later, if/when a code actually arrives.
 */
export async function getNumber(
  service: string,
  country: string,
): Promise<{ activationId: string; phoneNumber: string } | { error: string }> {
  const data = await call({ metod: "get_number", service, country });
  if (String(data?.response) === "1" && data?.number && data?.id) {
    const cc = String(data.CountryCode || "");
    return { activationId: String(data.id), phoneNumber: `${cc}${data.number}` };
  }
  return { error: String(data?.error_msg || `no_number_${data?.response ?? "?"}`) };
}

function extractCode(text: string): string {
  // e.g. "Your WhatsApp code: 181-025" -> "181025"; or a plain 4-8 digit code.
  const m = text.match(/(\d{3}[-\s]\d{3})|(\d{4,8})/);
  return m ? m[0].replace(/\s|-/g, "") : "";
}

/**
 * Poll for the code. Returns STATUS_OK (+code) when it lands, else
 * STATUS_WAIT_CODE. Never returns a "cancel" from an ambiguous/error response
 * (that would risk a premature refund) — expiry is handled by age in the
 * status/reconcile flows and by the user's manual cancel.
 */
export async function getSms(
  service: string,
  country: string,
  id: string,
): Promise<{ status: string; code?: string; text?: string }> {
  const data = await call({ metod: "get_sms", service, country, id });
  if (String(data?.response) === "1") {
    const raw = String(data?.sms || "").trim();
    const text = String(data?.text || "");
    return { status: "STATUS_OK", code: raw || extractCode(text), text };
  }
  return { status: "STATUS_WAIT_CODE" };
}

/** Release/cancel a rented number (best-effort). */
export async function cancel(service: string, country: string, id: string): Promise<string> {
  try {
    const d = await call({ metod: "denial", service, country, id });
    return String(d?.response ?? "ok");
  } catch {
    return "error";
  }
}
