// Server-authoritative VTU pricing catalog.
// The client NEVER tells the server how much a fixed-price item costs;
// it sends only an identifier, and the server resolves the price here.
// (Airtime and electricity are variable-amount and validated by range.)
//
// ALL AMOUNTS ARE IN KOBO (1 naira = 100 kobo). The wallet ledger is in kobo;
// when calling the VTU provider (which expects naira) divide by 100.

export type NetworkProvider = "mtn" | "airtel" | "glo" | "9mobile";

export const KOBO = 100;

// Airtime amount bounds (kobo): 鈧?0 .. 鈧?0,000.
export const AIRTIME_MIN = 100 * KOBO; // network/provider minimum airtime topup
export const AIRTIME_MAX = 50000 * KOBO;

// Electricity / bill amount bounds (kobo): 鈧?00 .. 鈧?00,000.
export const BILL_MIN = 500 * KOBO;
export const BILL_MAX = 100000 * KOBO;

// VTU.ng API v2's real electricity service_id list (v2 covers more DISCOs
// than the old Legacy v1 did 鈥?Enugu/Benin/Aba/Yola are now included).
export const ELECTRICITY_PROVIDERS = [
  "abuja-electric",
  "eko-electric",
  "ibadan-electric",
  "ikeja-electric",
  "jos-electric",
  "kaduna-electric",
  "kano-electric",
  "portharcourt-electric",
  "enugu-electric",
  "benin-electric",
  "aba-electric",
  "yola-electric",
];

export type TVServiceProvider = "dstv" | "gotv" | "startimes";

export interface ExamPinType {
  id: string;
  name: string;
  amount: number; // kobo, per PIN 鈥?default display/debit price
  // VTUnaija's documented basic/premium prices. `amount` mirrors the active
  // launch tier (premium); vtu-purchase reads the live
  // vtu_pricing_config('exam_pin') row to pick between these two at request
  // time, same runtime switch as data pricing (migration 074).
  premiumAmount?: number; // kobo 鈥?VTUnaija's real billed cost
  basicAmount?: number; // kobo 鈥?VTUnaija's suggested retail price (>= premium, the margin)
  serviceCode: "waec" | "neco" | "nabteb" | "jamb" | "waec-registration" | "nbais";
  productCode: string;
  quantityOptions: number[];
}

export const EXAM_PIN_TYPES: Record<string, ExamPinType> = Object.fromEntries(
  (
    [
      { id: "waec", name: "WAEC Exam PIN", amount: 5080, premiumAmount: 5080, basicAmount: 5150, serviceCode: "waec", productCode: "1", quantityOptions: [1] },
      { id: "neco", name: "NECO Exam PIN", amount: 2090, premiumAmount: 2090, basicAmount: 2350, serviceCode: "neco", productCode: "2", quantityOptions: [1] },
      { id: "nabteb", name: "NABTEB Exam PIN", amount: 880, premiumAmount: 880, basicAmount: 900, serviceCode: "nabteb", productCode: "3", quantityOptions: [1] },
      { id: "jamb", name: "JAMB Exam PIN", amount: 15000, premiumAmount: 15000, basicAmount: 15000, serviceCode: "jamb", productCode: "4", quantityOptions: [1] },
      { id: "waec-registration", name: "WAEC Registration PIN", amount: 15000, premiumAmount: 15000, basicAmount: 15000, serviceCode: "waec-registration", productCode: "5", quantityOptions: [1] },
      { id: "nbais", name: "NBAIS Exam PIN", amount: 1050, premiumAmount: 1050, basicAmount: 1150, serviceCode: "nbais", productCode: "6", quantityOptions: [1] },
    ] as ExamPinType[]
  ).map((e) => [
    e.id,
    { ...e, amount: e.amount * KOBO, premiumAmount: e.premiumAmount != null ? e.premiumAmount * KOBO : undefined, basicAmount: e.basicAmount != null ? e.basicAmount * KOBO : undefined },
  ]),
);

export const VALID_NETWORKS: NetworkProvider[] = ["mtn", "airtel", "glo"];

// VTUnaija's own numeric network codes (confirmed from their docs,
// 2026-07-30) 鈥?DISTINCT from VTU.ng's string service_ids and VTUAfrica's
// serviceCodes. Only used when providerPayload targets VTUnaija's /topup/ or
// /internetbundles/ endpoints. 9mobile is included for completeness even
// though VALID_NETWORKS doesn't currently allow it as a purchasable network.
export const VTUNAIJA_NETWORK_IDS: Record<NetworkProvider, number> = {
  mtn: 1,
  glo: 2,
  "9mobile": 3,
  airtel: 4,
};

// App-facing DISCO id -> VTUnaija's exact provider name string, confirmed
// live 2026-08-03 against their /listelectricity/ response (all 12,
// cross-referenced by name against ELECTRICITY_PROVIDERS above). Used to
// resolve the app's existing DISCO id to VTUnaija's current numeric
// disco_name code via vtunaija_electricity_catalog (a name-match, not a
// hardcoded numeric id, since that table is live-synced and the numeric
// code itself could change on VTUnaija's side).
export const VTUNAIJA_ELECTRICITY_NAME_MAP: Record<string, string> = {
  "ikeja-electric": "Ikeja Electricity Distribution Company",
  "eko-electric": "Eko Electricity Distribution Company",
  "kano-electric": "Kano Electricity Distribution Company (KEDCO)",
  "portharcourt-electric": "Port Harcourt Electricity Distribution Company (PHED)",
  "jos-electric": "Jos Electricity Distribution Company",
  "ibadan-electric": "Ibadan Electricity Distribution Company (IBEDC)",
  "kaduna-electric": "Kaduna Electricity Distribution Company (KEDCO)", // VTUnaija's own label 鈥?note it duplicates Kano's "(KEDCO)" acronym; used verbatim, doesn't affect functionality
  "abuja-electric": "Abuja Electricity Distribution Company (AEDC)",
  "enugu-electric": "Enugu Electricity Distribution Company (EEDC)",
  "benin-electric": "Benin Electricity Distribution Company (BEDC)",
  "yola-electric": "Yola Electricity Distribution Company",
  "aba-electric": "Aba Electricity Distribution Company",
};

// Resolves the app's own DISCO id to VTUnaija's current numeric disco_name
// code via the live-synced catalog (name-match, not a hardcoded numeric id 鈥?
// see VTUNAIJA_ELECTRICITY_NAME_MAP above). Shared by vtu-purchase (the
// actual debit) and verify-electricity-meter (the pre-payment name check) so
// both always resolve the exact same way. Returns null on any unknown/
// unavailable DISCO 鈥?callers must fail closed, never guess a code.
export async function resolveVtunaijaDiscoId(
  supabase: { from: (table: string) => any },
  billerId: string,
): Promise<string | null> {
  const discoName = VTUNAIJA_ELECTRICITY_NAME_MAP[billerId];
  if (!discoName) return null;
  const { data } = await supabase
    .from("vtunaija_electricity_catalog")
    .select("disco_id")
    .eq("name", discoName)
    .eq("available", true)
    .maybeSingle();
  return data?.disco_id ?? null;
}

// VTUnaija's cable provider codes, confirmed from their docs 2026-07-30.
// SHOWMAX (4) is intentionally omitted 鈥?not a supported TVServiceProvider.
export const VTUNAIJA_CABLE_IDS: Record<TVServiceProvider, number> = {
  gotv: 1,
  dstv: 2,
  startimes: 3,
};

// VTUnaija's current documented exam_name codes. These are the only exam
// products exposed by the app, so every Exam PIN purchase has one explicit,
// fail-closed mapping to the same provider.
export const VTUNAIJA_EXAM_IDS: Record<string, number> = {
  waec: 1,
  neco: 2,
  nabteb: 3,
  jamb: 4,
  "waec-registration": 5,
  nbais: 6,
};
