// CheckMyNINBVN — NIN "validation" (confirms a NIN is genuinely issued/
// active in NIMC's database; distinct from Prembly's plain lookup). This is
// an async, reviewed order (24-48h), not a live API response — submit,
// then poll status. Wallet is charged by the provider immediately on
// submission and auto-refunded if the order is rejected.
import { fetchWithTimeout } from "./provider-fetch.ts";

const NINBVN_API_KEY = Deno.env.get("NINBVN_API_KEY");
const NINBVN_BASE_URL = "https://checkmyninbvn.com.ng/api";

export class NinBvnError extends Error {}

export function isNinBvnConfigured(): boolean {
  return !!NINBVN_API_KEY;
}

async function call(path: string, body: Record<string, unknown>): Promise<{ status: number; data: any }> {
  if (!NINBVN_API_KEY) throw new NinBvnError("CheckMyNINBVN API key not configured");

  const res = await fetchWithTimeout(`${NINBVN_BASE_URL}${path}`, {
    method: "POST",
    headers: { "x-api-key": NINBVN_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, 30_000);
  return { status: res.status, data: await res.json() };
}

// Verify a NIN by number — response shape confirmed against their own docs
// (2026-07-05): { status: "success", data: { firstname, middlename, surname,
// telephoneno, residence_*, gender, nin, birthdate, photo } }. Same field
// names as Prembly's response, so nin-verify can treat both interchangeably.
export function verifyNin(nin: string) {
  return call("/nin-verification", { nin, consent: true });
}

// BVN verification — confirmed against CheckMyNINBVN's own docs
// (2026-07-05): POST /bvn-verification, body { bvn, consent }, response
// record fields (firstname/middlename/lastname/phone/dob/gender/photo)
// differ from their own NIN response ("lastname" here vs "surname" there).
export function verifyBvn(bvn: string) {
  return call("/bvn-verification", { bvn, consent: true });
}

export function submitNinValidation(ninDigits: string, dateOfBirth: string) {
  return call("/nin-modification", {
    service_type: "nin_validation",
    nin_digits: ninDigits,
    date_of_birth: dateOfBirth,
    consent: true,
  });
}

// The other three /nin-modification service types (confirmed 2026-07-05):
// each requires the person's CURRENT on-file details plus the corrected
// value(s). Reviewed order, 24-48h turnaround, ₦16,000/order — auto-refunded
// by the provider only if NIMC rejects it.
export type NinModificationType = "name" | "phone" | "address";

const MODIFICATION_SERVICE_TYPE: Record<NinModificationType, string> = {
  name: "nin_name_modification",
  phone: "nin_phone_modification",
  address: "nin_address_modification",
};

export function submitNinModification(type: NinModificationType, fields: Record<string, string>) {
  return call("/nin-modification", {
    service_type: MODIFICATION_SERVICE_TYPE[type],
    ...fields,
    consent: true,
  });
}

// Shared by nin_validation and all three modification types — same status
// endpoint resolves any /nin-modification order by its reference_id.
export function checkNinModificationStatus(referenceId: string) {
  return call("/nin-modification-status", { reference_id: referenceId });
}
