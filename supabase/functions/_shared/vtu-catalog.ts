// Server-authoritative VTU pricing catalog.
// The client NEVER tells the server how much a fixed-price item costs;
// it sends only an identifier, and the server resolves the price here.
// (Airtime and electricity are variable-amount and validated by range.)
//
// ALL AMOUNTS ARE IN KOBO (1 naira = 100 kobo). The wallet ledger is in kobo;
// when calling the VTU provider (which expects naira) divide by 100.

export type NetworkProvider = "mtn" | "airtel" | "glo" | "9mobile";

export const KOBO = 100;

// Airtime amount bounds (kobo): ₦50 .. ₦50,000.
export const AIRTIME_MIN = 100 * KOBO; // network/provider minimum airtime topup
export const AIRTIME_MAX = 50000 * KOBO;

// Electricity / bill amount bounds (kobo): ₦500 .. ₦100,000.
export const BILL_MIN = 500 * KOBO;
export const BILL_MAX = 100000 * KOBO;

// VTU.ng API v2's real electricity service_id list (v2 covers more DISCOs
// than the old Legacy v1 did — Enugu/Benin/Aba/Yola are now included).
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

interface DataBundle {
  id: string;
  amount: number; // kobo — the confirmed VTUAfrica "Portal Owner" cost,
  // charged to the customer unchanged (zero markup, by explicit choice —
  // matches how Glo data was already priced here before this catalog
  // absorbed MTN/Airtel/9mobile too).
  network: NetworkProvider;
  serviceCode: string; // VTUAfrica's per-category network code, e.g. "MTNSME"
  planCode: string; // VTUAfrica's own DataPlan code, e.g. "500W"
}

// Real, live catalog pulled directly from VTUAfrica's own Data Bundle API
// docs page (confirmed live, 2026-07-03) — service + DataPlan codes and
// Portal Owner prices are authoritative. Only plans marked "Active" are
// included; "Disabled" plans (several of which have nonsensical negative
// prices) are skipped entirely. Categories with no Active plans (MTN
// Corporate, Airtel Awoof, Glo Awoof, 9mobile Awoof) are omitted.
export const DATA_BUNDLES: Record<string, DataBundle> = Object.fromEntries(
  (
    [
      // MTN SME
      { network: "mtn", category: "sme", serviceCode: "MTNSME", planCode: "500W", amount: 330 }, // 500MB - 7 Days
      { network: "mtn", category: "sme", serviceCode: "MTNSME", planCode: "5000W", amount: 1840 }, // 5GB - 7 Days
      { network: "mtn", category: "sme", serviceCode: "MTNSME", planCode: "6000W", amount: 2460 }, // 6GB - 7 Days
      { network: "mtn", category: "sme", serviceCode: "MTNSME", planCode: "1000", amount: 770 }, // 1GB - 30 Days
      { network: "mtn", category: "sme", serviceCode: "MTNSME", planCode: "2000", amount: 1430 }, // 2GB - 30 Days
      { network: "mtn", category: "sme", serviceCode: "MTNSME", planCode: "3000", amount: 1770 }, // 3GB - 30 Days
      { network: "mtn", category: "sme", serviceCode: "MTNSME", planCode: "10000", amount: 4470 }, // 10GB - 30 Days

      // MTN Gifting
      { network: "mtn", category: "gift", serviceCode: "MTNGIFT", planCode: "40", amount: 52 }, // 40MB - 1 Day
      { network: "mtn", category: "gift", serviceCode: "MTNGIFT", planCode: "75", amount: 76 }, // 75MB - 1 Day
      { network: "mtn", category: "gift", serviceCode: "MTNGIFT", planCode: "500", amount: 490 }, // 500MB - 7 Days
      { network: "mtn", category: "gift", serviceCode: "MTNGIFT", planCode: "750", amount: 440 }, // 750MB - 3 Days
      { network: "mtn", category: "gift", serviceCode: "MTNGIFT", planCode: "1000D", amount: 490 }, // 1GB - 1 Day
      { network: "mtn", category: "gift", serviceCode: "MTNGIFT", planCode: "2000D", amount: 735 }, // 2GB - 2 Days
      { network: "mtn", category: "gift", serviceCode: "MTNGIFT", planCode: "2501D", amount: 735 }, // 2.5GB - 1 Day
      { network: "mtn", category: "gift", serviceCode: "MTNGIFT", planCode: "2500D", amount: 880 }, // 2.5GB - 2 Days
      { network: "mtn", category: "gift", serviceCode: "MTNGIFT", planCode: "3200D", amount: 980 }, // 3.2GB - 2 Days
      { network: "mtn", category: "gift", serviceCode: "MTNGIFT", planCode: "1000W", amount: 780 }, // 1GB - 7 Days
      { network: "mtn", category: "gift", serviceCode: "MTNGIFT", planCode: "1500W", amount: 975 }, // 1.5GB - 7 Days
      { network: "mtn", category: "gift", serviceCode: "MTNGIFT", planCode: "6000W", amount: 2415 }, // 6GB - 7 Days
      { network: "mtn", category: "gift", serviceCode: "MTNGIFT", planCode: "2000", amount: 1465 }, // 2GB - 30 Days
      { network: "mtn", category: "gift", serviceCode: "MTNGIFT", planCode: "2700", amount: 1950 }, // 2.7GB - 30 Days
      { network: "mtn", category: "gift", serviceCode: "MTNGIFT", planCode: "3500", amount: 2425 }, // 3.5GB - 30 Days
      { network: "mtn", category: "gift", serviceCode: "MTNGIFT", planCode: "10000", amount: 4375 }, // 10GB - 30 Days
      { network: "mtn", category: "gift", serviceCode: "MTNGIFT", planCode: "12500", amount: 5430 }, // 12.5GB - 30 Days
      { network: "mtn", category: "gift", serviceCode: "MTNGIFT", planCode: "5000", amount: 2580 }, // 5GB - 30 Days
      { network: "mtn", category: "gift", serviceCode: "MTNGIFT", planCode: "7000", amount: 3445 }, // 7GB - 30 Days
      { network: "mtn", category: "gift", serviceCode: "MTNGIFT", planCode: "16500", amount: 6355 }, // 16.5GB - 30 Days
      { network: "mtn", category: "gift", serviceCode: "MTNGIFT", planCode: "20000", amount: 7500 }, // 20GB - 30 Days
      { network: "mtn", category: "gift", serviceCode: "MTNGIFT", planCode: "25000", amount: 8900 }, // 25GB - 30 Days
      { network: "mtn", category: "gift", serviceCode: "MTNGIFT", planCode: "36000", amount: 10800 }, // 36GB - 30 Days
      { network: "mtn", category: "gift", serviceCode: "MTNGIFT", planCode: "75000", amount: 17470 }, // 75GB - 30 Days

      // MTN Awoof
      { network: "mtn", category: "awoof", serviceCode: "MTNAWOOF", planCode: "1000D", amount: 490 }, // 1GB - 1 Day
      { network: "mtn", category: "awoof", serviceCode: "MTNAWOOF", planCode: "1400W", amount: 1756 }, // 1.4GB - 3 Days
      { network: "mtn", category: "awoof", serviceCode: "MTNAWOOF", planCode: "20000W", amount: 9825 }, // 20GB - 7 Days

      // Airtel SME
      { network: "airtel", category: "sme", serviceCode: "AIRTELSME", planCode: "150", amount: 65 }, // 150MB - 1 Day
      { network: "airtel", category: "sme", serviceCode: "AIRTELSME", planCode: "300", amount: 114 }, // 300MB - 2 Days
      { network: "airtel", category: "sme", serviceCode: "AIRTELSME", planCode: "600", amount: 220 }, // 600MB - 2 Days
      { network: "airtel", category: "sme", serviceCode: "AIRTELSME", planCode: "1000D", amount: 358 }, // 1GB - 1 Day
      { network: "airtel", category: "sme", serviceCode: "AIRTELSME", planCode: "3000W", amount: 1070 }, // 3GB - 7 Days
      { network: "airtel", category: "sme", serviceCode: "AIRTELSME", planCode: "7000W", amount: 2035 }, // 7GB - 7 Days
      { network: "airtel", category: "sme", serviceCode: "AIRTELSME", planCode: "4000", amount: 2450 }, // 4GB - 30 Days
      { network: "airtel", category: "sme", serviceCode: "AIRTELSME", planCode: "10000", amount: 3100 }, // 10GB - 30 Days
      { network: "airtel", category: "sme", serviceCode: "AIRTELSME", planCode: "13000", amount: 4925 }, // 13GB - 30 Days

      // Airtel Corporate
      { network: "airtel", category: "corp", serviceCode: "AIRTELCG", planCode: "100", amount: 105 }, // 100MB - 7 Days
      { network: "airtel", category: "corp", serviceCode: "AIRTELCG", planCode: "300", amount: 270 }, // 300MB - 7 Days
      { network: "airtel", category: "corp", serviceCode: "AIRTELCG", planCode: "500", amount: 490 }, // 500MB - 30 Days
      { network: "airtel", category: "corp", serviceCode: "AIRTELCG", planCode: "1000", amount: 980 }, // 1GB - 30 Days
      { network: "airtel", category: "corp", serviceCode: "AIRTELCG", planCode: "2000", amount: 1960 }, // 2GB - 30 Days
      { network: "airtel", category: "corp", serviceCode: "AIRTELCG", planCode: "5000", amount: 4900 }, // 5GB - 30 Days
      { network: "airtel", category: "corp", serviceCode: "AIRTELCG", planCode: "10000", amount: 9800 }, // 10GB - 30 Days
      { network: "airtel", category: "corp", serviceCode: "AIRTELCG", planCode: "15000", amount: 14700 }, // 15GB - 30 Days
      { network: "airtel", category: "corp", serviceCode: "AIRTELCG", planCode: "20000", amount: 19600 }, // 20GB - 30 Days

      // Airtel Gifting
      { network: "airtel", category: "gift", serviceCode: "AIRTELGIFT", planCode: "75", amount: 79.9 }, // 75MB - 1 Day
      { network: "airtel", category: "gift", serviceCode: "AIRTELGIFT", planCode: "200", amount: 206 }, // 200MB - 3 Days
      { network: "airtel", category: "gift", serviceCode: "AIRTELGIFT", planCode: "500", amount: 496 }, // 500MB - 3 Days
      { network: "airtel", category: "gift", serviceCode: "AIRTELGIFT", planCode: "1000D", amount: 495 }, // 1GB - 1 Day
      { network: "airtel", category: "gift", serviceCode: "AIRTELGIFT", planCode: "1500D", amount: 595 }, // 1.5GB - 2 Days
      { network: "airtel", category: "gift", serviceCode: "AIRTELGIFT", planCode: "3000D", amount: 990 }, // 3GB - 2 Days
      { network: "airtel", category: "gift", serviceCode: "AIRTELGIFT", planCode: "1000W", amount: 790 }, // 1GB - 7 Days
      { network: "airtel", category: "gift", serviceCode: "AIRTELGIFT", planCode: "1500W", amount: 995 }, // 1.5GB - 7 Days
      { network: "airtel", category: "gift", serviceCode: "AIRTELGIFT", planCode: "6000W", amount: 2493 }, // 6GB - 7 Days
      { network: "airtel", category: "gift", serviceCode: "AIRTELGIFT", planCode: "2000", amount: 1485 }, // 2GB - 30 Days
      { network: "airtel", category: "gift", serviceCode: "AIRTELGIFT", planCode: "3000", amount: 1980 }, // 3GB - 30 Days
      { network: "airtel", category: "gift", serviceCode: "AIRTELGIFT", planCode: "4000", amount: 2502 }, // 4GB - 30 Days
      { network: "airtel", category: "gift", serviceCode: "AIRTELGIFT", planCode: "8000", amount: 2993 }, // 8GB - 30 Days
      { network: "airtel", category: "gift", serviceCode: "AIRTELGIFT", planCode: "10000", amount: 3990 }, // 10GB - 30 Days
      { network: "airtel", category: "gift", serviceCode: "AIRTELGIFT", planCode: "13000", amount: 4973 }, // 13GB - 30 Days
      { network: "airtel", category: "gift", serviceCode: "AIRTELGIFT", planCode: "18000", amount: 6000 }, // 18GB - 30 Days
      { network: "airtel", category: "gift", serviceCode: "AIRTELGIFT", planCode: "25000", amount: 8055 }, // 25GB - 30 Days
      { network: "airtel", category: "gift", serviceCode: "AIRTELGIFT", planCode: "35000", amount: 10000 }, // 35GB - 30 Days
      { network: "airtel", category: "gift", serviceCode: "AIRTELGIFT", planCode: "60000", amount: 15275 }, // 60GB - 30 Days

      // Glo SME
      { network: "glo", category: "sme", serviceCode: "GLOSME", planCode: "50", amount: 52 }, // 50MB - 1 Day
      { network: "glo", category: "sme", serviceCode: "GLOSME", planCode: "125", amount: 98 }, // 125MB - 1 Day
      { network: "glo", category: "sme", serviceCode: "GLOSME", planCode: "260", amount: 192 }, // 260MB - 2 Days
      { network: "glo", category: "sme", serviceCode: "GLOSME", planCode: "350", amount: 100 }, // 350MB - 1 Day
      { network: "glo", category: "sme", serviceCode: "GLOSME", planCode: "750N", amount: 119 }, // 750MB - 1 Night
      { network: "glo", category: "sme", serviceCode: "GLOSME", planCode: "750", amount: 205 }, // 750MB - 1 Day
      { network: "glo", category: "sme", serviceCode: "GLOSME", planCode: "1250D", amount: 200 }, // 1.25GB - Sunday
      { network: "glo", category: "sme", serviceCode: "GLOSME", planCode: "1500D", amount: 300 }, // 1.5GB - 1 Day
      { network: "glo", category: "sme", serviceCode: "GLOSME", planCode: "2500D", amount: 500 }, // 2.5GB - 2 Days
      { network: "glo", category: "sme", serviceCode: "GLOSME", planCode: "10000W", amount: 2000 }, // 10GB - 7 Days

      // Glo Corporate
      { network: "glo", category: "corp", serviceCode: "GLOCG", planCode: "200", amount: 90 }, // 200MB - 14 Days
      { network: "glo", category: "corp", serviceCode: "GLOCG", planCode: "500", amount: 210 }, // 500MB - 30 Days
      { network: "glo", category: "corp", serviceCode: "GLOCG", planCode: "1000", amount: 408 }, // 1GB - 30 Days
      { network: "glo", category: "corp", serviceCode: "GLOCG", planCode: "2000", amount: 816 }, // 2GB - 30 Days
      { network: "glo", category: "corp", serviceCode: "GLOCG", planCode: "3000", amount: 1225 }, // 3GB - 30 Days
      { network: "glo", category: "corp", serviceCode: "GLOCG", planCode: "5000", amount: 2040 }, // 5GB - 30 Days
      { network: "glo", category: "corp", serviceCode: "GLOCG", planCode: "10000", amount: 4050 }, // 10GB - 30 Days

      // Glo Gifting
      { network: "glo", category: "gift", serviceCode: "GLOGIFT", planCode: "50", amount: 51 }, // 50MB - 1 Day
      { network: "glo", category: "gift", serviceCode: "GLOGIFT", planCode: "150", amount: 97 }, // 150MB - 1 Day
      { network: "glo", category: "gift", serviceCode: "GLOGIFT", planCode: "350", amount: 191 }, // 350MB - 1 Day
      { network: "glo", category: "gift", serviceCode: "GLOGIFT", planCode: "1000W", amount: 470 }, // 1GB - 14 Days
      { network: "glo", category: "gift", serviceCode: "GLOGIFT", planCode: "3900", amount: 945 }, // 3.9GB - 30 Days
      { network: "glo", category: "gift", serviceCode: "GLOGIFT", planCode: "7500", amount: 2380 }, // 7.5GB - 30 Days
      { network: "glo", category: "gift", serviceCode: "GLOGIFT", planCode: "9000", amount: 1905 }, // 9.2GB - 30 Days
      { network: "glo", category: "gift", serviceCode: "GLOGIFT", planCode: "10000", amount: 2865 }, // 10.8GB - 30 Days
      { network: "glo", category: "gift", serviceCode: "GLOGIFT", planCode: "14000", amount: 3830 }, // 14GB - 30 Days
      { network: "glo", category: "gift", serviceCode: "GLOGIFT", planCode: "18000", amount: 4760 }, // 18GB - 30 Days

      // 9mobile SME
      { network: "9mobile", category: "sme", serviceCode: "9MOBILESME", planCode: "250", amount: 81 }, // 250MB - 14 Days
      { network: "9mobile", category: "sme", serviceCode: "9MOBILESME", planCode: "500", amount: 135 }, // 500MB - 30 Days
      { network: "9mobile", category: "sme", serviceCode: "9MOBILESME", planCode: "3500", amount: 905 }, // 3.5GB - 30 Days
      { network: "9mobile", category: "sme", serviceCode: "9MOBILESME", planCode: "7000", amount: 1750 }, // 7GB - 30 Days
      { network: "9mobile", category: "sme", serviceCode: "9MOBILESME", planCode: "15000", amount: 3100 }, // 15GB - 30 Days

      // 9mobile Corporate
      { network: "9mobile", category: "corp", serviceCode: "9MOBILECG", planCode: "500", amount: 147 }, // 500MB - 30 Days
      { network: "9mobile", category: "corp", serviceCode: "9MOBILECG", planCode: "1000", amount: 285 }, // 1GB - 30 Days
      { network: "9mobile", category: "corp", serviceCode: "9MOBILECG", planCode: "1500", amount: 435 }, // 1.5GB - 30 Days
      { network: "9mobile", category: "corp", serviceCode: "9MOBILECG", planCode: "2000", amount: 570 }, // 2GB - 30 Days
      { network: "9mobile", category: "corp", serviceCode: "9MOBILECG", planCode: "3000", amount: 855 }, // 3GB - 30 Days
      { network: "9mobile", category: "corp", serviceCode: "9MOBILECG", planCode: "4000", amount: 1140 }, // 4GB - 30 Days
      { network: "9mobile", category: "corp", serviceCode: "9MOBILECG", planCode: "4500", amount: 1283 }, // 4.5GB - 30 Days
      { network: "9mobile", category: "corp", serviceCode: "9MOBILECG", planCode: "5000", amount: 1425 }, // 5GB - 30 Days
      { network: "9mobile", category: "corp", serviceCode: "9MOBILECG", planCode: "10000", amount: 2850 }, // 10GB - 30 Days
      { network: "9mobile", category: "corp", serviceCode: "9MOBILECG", planCode: "11000", amount: 4125 }, // 11GB - 30 Days
      { network: "9mobile", category: "corp", serviceCode: "9MOBILECG", planCode: "15000", amount: 4275 }, // 15GB - 30 Days
      { network: "9mobile", category: "corp", serviceCode: "9MOBILECG", planCode: "20000", amount: 5700 }, // 20GB - 30 Days
      { network: "9mobile", category: "corp", serviceCode: "9MOBILECG", planCode: "25000", amount: 7125 }, // 25GB - 30 Days
      { network: "9mobile", category: "corp", serviceCode: "9MOBILECG", planCode: "30000", amount: 8550 }, // 30GB - 30 Days
      { network: "9mobile", category: "corp", serviceCode: "9MOBILECG", planCode: "40000", amount: 11350 }, // 40GB - 30 Days

      // 9mobile Gifting
      { network: "9mobile", category: "gift", serviceCode: "9MOBILEGIFT", planCode: "25", amount: 87 }, // 25MB - 1 Day
      { network: "9mobile", category: "gift", serviceCode: "9MOBILEGIFT", planCode: "2000D", amount: 850 }, // 2GB - 1 Day
      { network: "9mobile", category: "gift", serviceCode: "9MOBILEGIFT", planCode: "100", amount: 187 }, // 100MB - 7 Days
      { network: "9mobile", category: "gift", serviceCode: "9MOBILEGIFT", planCode: "250", amount: 160 }, // 250MB - 14 Days
      { network: "9mobile", category: "gift", serviceCode: "9MOBILEGIFT", planCode: "350", amount: 594 }, // 350MB - 7 Days
      { network: "9mobile", category: "gift", serviceCode: "9MOBILEGIFT", planCode: "1500W", amount: 705 }, // 1.5GB - 7 Days
      { network: "9mobile", category: "gift", serviceCode: "9MOBILEGIFT", planCode: "7000W", amount: 2510 }, // 7GB - 7 Days
      { network: "9mobile", category: "gift", serviceCode: "9MOBILEGIFT", planCode: "500", amount: 320 }, // 500MB - 14 Days
      { network: "9mobile", category: "gift", serviceCode: "9MOBILEGIFT", planCode: "5000W", amount: 2350 }, // 5GB - 14 Days
      { network: "9mobile", category: "gift", serviceCode: "9MOBILEGIFT", planCode: "1500", amount: 1660 }, // 1.5GB - 30 Days
      { network: "9mobile", category: "gift", serviceCode: "9MOBILEGIFT", planCode: "2000", amount: 1984 }, // 2GB - 30 Days
      { network: "9mobile", category: "gift", serviceCode: "9MOBILEGIFT", planCode: "3000", amount: 2480 }, // 3GB - 30 Days
      { network: "9mobile", category: "gift", serviceCode: "9MOBILEGIFT", planCode: "4500", amount: 3320 }, // 4.5GB - 30 Days
      { network: "9mobile", category: "gift", serviceCode: "9MOBILEGIFT", planCode: "5500", amount: 6840 }, // 5.5GB - 30 Days
      { network: "9mobile", category: "gift", serviceCode: "9MOBILEGIFT", planCode: "11000", amount: 6630 }, // 11GB - 30 Days
      { network: "9mobile", category: "gift", serviceCode: "9MOBILEGIFT", planCode: "15000", amount: 8300 }, // 15GB - 30 Days
      { network: "9mobile", category: "gift", serviceCode: "9MOBILEGIFT", planCode: "25000", amount: 17820 }, // 25GB - 30 Days
    ] as { network: NetworkProvider; category: string; serviceCode: string; planCode: string; amount: number }[]
  ).map((b) => {
    const id = `${b.network}-${b.category}-${b.planCode.toLowerCase()}`;
    return [id, { id, amount: Math.round(b.amount * KOBO), network: b.network, serviceCode: b.serviceCode, planCode: b.planCode }];
  }),
);

// VTU.ng v2 plans currently marked Available by its public variations API.
// `amount` is the customer/API price; the lower reseller debit remains the
// app's margin. The server owns this mapping so a modified client cannot pick
// a cheaper amount or an unavailable variation.
export interface VTUNGDataBundle {
  id: string;
  amount: number;
  network: NetworkProvider;
  variationId: string;
}

export const VTUNG_DATA_BUNDLES: Record<string, VTUNGDataBundle> = Object.fromEntries(
  (
    [
      { network: "mtn", variationId: "244540", amount: 6699 },
      { network: "mtn", variationId: "5506674", amount: 499 },
      { network: "mtn", variationId: "244538", amount: 3699 },
      { network: "mtn", variationId: "2673", amount: 11999 },
      { network: "mtn", variationId: "5506738", amount: 2599 },
      { network: "mtn", variationId: "2677", amount: 4799 },
      { network: "mtn", variationId: "244542", amount: 1599 },
      { network: "mtn", variationId: "2676", amount: 819 },
      { network: "mtn", variationId: "2667", amount: 19999 },

      { network: "airtel", variationId: "244698", amount: 819 },
      { network: "airtel", variationId: "2669", amount: 10499 },
      { network: "airtel", variationId: "2672", amount: 1519 },
      { network: "airtel", variationId: "2675", amount: 3199 },
      { network: "airtel", variationId: "244721", amount: 2099 },
      { network: "airtel", variationId: "2668", amount: 15599 },
      { network: "airtel", variationId: "2674", amount: 4299 },
      { network: "airtel", variationId: "2670", amount: 6399 },

      { network: "glo", variationId: "5580757", amount: 249 },
      { network: "glo", variationId: "5580758", amount: 149 },
      { network: "glo", variationId: "244659", amount: 549 },
      { network: "glo", variationId: "2660", amount: 1099 },
      { network: "glo", variationId: "244658", amount: 1599 },
      { network: "glo", variationId: "244668", amount: 2599 },
      { network: "glo", variationId: "2665", amount: 3199 },
      { network: "glo", variationId: "2663", amount: 5299 },
      { network: "glo", variationId: "2251529", amount: 299 },
      { network: "glo", variationId: "2661", amount: 10599 },
      { network: "glo", variationId: "2251528", amount: 549 },
      { network: "glo", variationId: "2251526", amount: 1099 },
    ] as { network: NetworkProvider; variationId: string; amount: number }[]
  ).map((bundle) => {
    const id = `vtung-${bundle.network}-${bundle.variationId}`;
    return [id, { ...bundle, id, amount: bundle.amount * KOBO }];
  }),
);

export type TVServiceProvider = "dstv" | "gotv" | "startimes";

interface TVBouquet {
  id: string;
  amount: number; // kobo — the official bouquet price (DStv/GOtv/Startimes
  // set these nationally; VTUAfrica's own confirmed prices match what VTU.ng
  // listed for every overlapping DStv/GOtv tier exactly).
  serviceId: TVServiceProvider;
  variationCode: string; // VTUAfrica's own `variation` parameter value
}

// Real, live catalog pulled directly from VTUAfrica's own "Subscription
// Plans and Prices" API page (confirmed live, 2026-07-03) — variation codes
// and prices are authoritative. VTUAfrica's own catalog differs from what
// VTU.ng offered: no GOtv Supa/Supa Plus here, and Startimes is priced by
// tier + billing cadence (weekly/monthly) rather than Antenna/Dish, plus a
// "Smart" tier VTU.ng didn't have. Startimes daily and "Unique" variants
// came back ₦0.0 (unpriced/unavailable) and are excluded.
export const TV_BOUQUETS: Record<string, TVBouquet> = Object.fromEntries(
  (
    [
      // DStv
      { slug: "padi", amount: 4400, serviceId: "dstv", variationCode: "dstv_padi" },
      { slug: "yanga", amount: 6000, serviceId: "dstv", variationCode: "dstv_yanga" },
      { slug: "confam", amount: 11000, serviceId: "dstv", variationCode: "dstv_confam" },
      { slug: "compact", amount: 19000, serviceId: "dstv", variationCode: "dstv_compact" },
      { slug: "compact-plus", amount: 30000, serviceId: "dstv", variationCode: "dstv_compact_plus" },
      { slug: "premium", amount: 44500, serviceId: "dstv", variationCode: "dstv_premium" },
      { slug: "asia", amount: 14900, serviceId: "dstv", variationCode: "dstv_asia" },
      { slug: "premium-french", amount: 69000, serviceId: "dstv", variationCode: "dstv_premium_french" },

      // GOtv
      { slug: "smallie", amount: 1900, serviceId: "gotv", variationCode: "gotv_smallie" },
      { slug: "smallie-3months", amount: 5100, serviceId: "gotv", variationCode: "gotv_smallie_3months" },
      { slug: "smallie-1year", amount: 15000, serviceId: "gotv", variationCode: "gotv_smallie_1year" },
      { slug: "jinja", amount: 3900, serviceId: "gotv", variationCode: "gotv_jinja" },
      { slug: "jolli", amount: 5800, serviceId: "gotv", variationCode: "gotv_jolli" },
      { slug: "max", amount: 8500, serviceId: "gotv", variationCode: "gotv_max" },

      // Startimes
      { slug: "nova-weekly", amount: 600, serviceId: "startimes", variationCode: "startimes_nova_weekly" },
      { slug: "nova-monthly", amount: 1900, serviceId: "startimes", variationCode: "startimes_nova" },
      { slug: "basic-weekly", amount: 1250, serviceId: "startimes", variationCode: "startimes_basic_weekly" },
      { slug: "basic-monthly", amount: 3700, serviceId: "startimes", variationCode: "startimes_basic" },
      { slug: "smart-weekly", amount: 1550, serviceId: "startimes", variationCode: "startimes_smart_weekly" },
      { slug: "smart-monthly", amount: 4700, serviceId: "startimes", variationCode: "startimes_smart" },
      { slug: "classic-weekly", amount: 1900, serviceId: "startimes", variationCode: "startimes_classic_weekly" },
      { slug: "classic-monthly", amount: 5500, serviceId: "startimes", variationCode: "startimes_classic" },
      { slug: "super-weekly", amount: 3000, serviceId: "startimes", variationCode: "startimes_super_weekly" },
      { slug: "super-monthly", amount: 9000, serviceId: "startimes", variationCode: "startimes_super" },
    ] as { slug: string; amount: number; serviceId: TVServiceProvider; variationCode: string }[]
  ).map((b) => {
    const id = `${b.serviceId}-${b.slug}`;
    return [id, { id, amount: b.amount * KOBO, serviceId: b.serviceId, variationCode: b.variationCode }];
  }),
);

// Exam PINs — routed to VTUAfrica's `/exam-pin` endpoint (confirmed live
// docs, 2026-07-02). `serviceCode` + `productCode` are VTUAfrica's own
// identifiers. NECO GCE (listed at ₦2) and NABTEB GCE (₦33) are excluded —
// those prices are obvious data-entry errors on VTUAfrica's pricing page
// (compare WAEC GCE's believable ₦24,000) and shipping them would either
// lose money on every sale or misquote the customer.
export interface ExamPinType {
  id: string;
  name: string;
  amount: number; // kobo, per PIN
  serviceCode: "waec" | "neco" | "nabteb" | "jamb";
  productCode: string;
  quantityOptions: number[];
  // JAMB PINs are tied to one candidate's own JAMB profile (obtained
  // directly from JAMB, not something we generate) — required per VTUAfrica's
  // docs, and quantity is locked to 1 since a profile code can't be reused
  // across multiple registration PINs in one purchase.
  requiresProfileCode?: boolean;
}

export const EXAM_PIN_TYPES: Record<string, ExamPinType> = Object.fromEntries(
  (
    [
      { id: "waec-result", name: "WAEC Result Checking PIN", amount: 5000, serviceCode: "waec", productCode: "1", quantityOptions: [1, 2, 3, 4, 5] },
      { id: "waec-verification", name: "WAEC Verification PIN", amount: 4000, serviceCode: "waec", productCode: "3", quantityOptions: [1, 2, 3, 4, 5] },
      { id: "waec-gce", name: "WAEC GCE Registration PIN", amount: 24000, serviceCode: "waec", productCode: "2", quantityOptions: [1, 2, 3, 4, 5] },
      { id: "neco-result", name: "NECO Result Checking Token", amount: 2100, serviceCode: "neco", productCode: "1", quantityOptions: [1, 2, 3, 4, 5] },
      { id: "nabteb-result", name: "NABTEB Result Checking PIN", amount: 1200, serviceCode: "nabteb", productCode: "1", quantityOptions: [1, 2, 3, 4, 5] },
      { id: "jamb-utme", name: "JAMB UTME Registration PIN", amount: 7150, serviceCode: "jamb", productCode: "1", quantityOptions: [1], requiresProfileCode: true },
      { id: "jamb-direct-entry", name: "JAMB Direct Entry Registration PIN", amount: 5650, serviceCode: "jamb", productCode: "2", quantityOptions: [1], requiresProfileCode: true },
    ] as ExamPinType[]
  ).map((e) => [e.id, { ...e, amount: e.amount * KOBO }]),
);

export const VALID_NETWORKS: NetworkProvider[] = ["mtn", "airtel", "glo"];
