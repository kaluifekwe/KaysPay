// ---------------------------------------------------------------------
// Kobo <-> Naira conversion. The server (DB + RPCs) is the source of truth
// and works in integer KOBO. The client UI works in NAIRA. Convert at the
// service boundary only: koboToNaira on read, nairaToKobo on send.
// ---------------------------------------------------------------------

/** Convert integer kobo from the server into naira for display. */
export function koboToNaira(kobo: number): number {
  return (kobo ?? 0) / 100;
}

/** Convert user-entered naira into integer kobo for the server. */
export function nairaToKobo(naira: number): number {
  return Math.round((naira ?? 0) * 100);
}

// Manual grouping (commas for thousands, dot for decimals). We do NOT use
// Intl.NumberFormat because React Native's Hermes engine ships without full
// ICU locale data, so 'en-NG' falls back to dot-grouping (e.g. "₦10.501,00"),
// which looks like a wrong amount. This is locale-independent and consistent.
function groupThousands(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function formatNaira(amount: number): string {
  const n = Number.isFinite(amount) ? amount : 0;
  const [intPart, decPart] = Math.abs(n).toFixed(2).split('.');
  return `${n < 0 ? '-' : ''}₦${groupThousands(intPart)}.${decPart}`;
}

export function formatNairaCompact(amount: number): string {
  if (amount >= 1000000) {
    return `₦${(amount / 1000000).toFixed(1)}M`;
  }
  if (amount >= 1000) {
    return `₦${(amount / 1000).toFixed(1)}K`;
  }
  return formatNaira(amount);
}

export function formatUSD(amount: number): string {
  const n = Number.isFinite(amount) ? amount : 0;
  const [intPart, decPart] = Math.abs(n).toFixed(2).split('.');
  return `${n < 0 ? '-' : ''}$${groupThousands(intPart)}.${decPart}`;
}

export function parseNairaInput(input: string): number {
  // Remove all non-numeric characters except decimal point
  const cleaned = input.replace(/[^0-9.]/g, '');
  const parsed = parseFloat(cleaned);
  return isNaN(parsed) ? 0 : parsed;
}

export function calculateAirtimeCharge(amount: number, network: string): number {
  // Service charge rates (example rates)
  const chargeRates: Record<string, number> = {
    MTN: 0.03, // 3%
    Airtel: 0.02, // 2%
    Glo: 0.02, // 2%
    '9mobile': 0.02, // 2%
  };

  const rate = chargeRates[network] || 0.03;
  return amount * (1 - rate);
}

export function formatPhoneForDisplay(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length !== 11) return phone;

  return `0${digits.slice(1, 4)} *** ${digits.slice(7)}`;
}
