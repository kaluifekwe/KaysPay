export interface TxRow {
  id: string;
  user_id: string;
  type: string;
  recipient_phone: string | null;
  network: string | null;
  amount_ngn: number;
  status: string;
  vtu_order_id: string | null;
  created_at: string;
  completed_at: string | null;
  funding_provider?: string | null;
  funding_reference?: string | null;
  // Already returned by admin-transactions; typed here so the dashboard can
  // read failure_reason and tell an abandoned checkout ("not_paid") apart
  // from a purchase that genuinely failed.
  metadata?: Record<string, unknown> | null;
  users: { full_name: string | null; phone: string | null } | null;
  service_refunds?: { reason: string; origin: string; created_at: string }[];
  refund_verification?: {
    provider: string;
    outcome: 'success' | 'failed' | 'unknown';
    query_reference: string;
    provider_transaction_id: string | null;
    message: string;
    verified_at: string;
  } | null;
}

export function formatFundingProvider(provider: string | null | undefined): string {
  if (!provider) return '—';
  if (provider.toLowerCase() === 'paystack') return 'Paystack';
  if (provider.toLowerCase() === 'flutterwave') return 'Flutterwave';
  return provider;
}

// User-facing service groupings, not raw provider/type granularity — e.g.
// every NIN/BVN sub-type collapses into one "Identity Verification" filter
// option. Electricity and Cable TV both persist as type 'bill' (see
// vtu-purchase/index.ts), so they share one entry here too. card_fund,
// refund, payroll, and withdrawal are all confirmed-dead types (nothing
// ever creates a row with them) and are deliberately omitted — they'd
// only ever show "0 results" as filter options.
export const SERVICES: { label: string; types: string[] }[] = [
  { label: 'Airtime', types: ['airtime'] },
  { label: 'Data', types: ['data'] },
  { label: 'Electricity & TV', types: ['bill'] },
  { label: 'Exam Pins', types: ['exam_pin'] },
  { label: 'eSIM', types: ['esim'] },
  { label: 'Foreign Number', types: ['foreign_number'] },
  {
    label: 'Identity Verification (NIN/BVN)',
    types: [
      'nin_verification', 'nin_validation', 'bvn_verification',
      'nin_name_modification', 'nin_phone_modification', 'nin_address_modification',
    ],
  },
  { label: 'Wallet Funding', types: ['wallet_fund'] },
  { label: 'Crypto', types: ['crypto_buy', 'crypto_sell', 'crypto_withdraw'] },
];

export function serviceLabelForType(type: string): string {
  return SERVICES.find((s) => s.types.includes(type))?.label ?? type;
}

// Mirrors supabase/functions/admin-refund/index.ts's SIMPLE_REFUNDABLE_TYPES
// — client-side this only controls whether the Refund option renders; the
// edge function is the real authority and re-checks this itself. A refund
// always credits back exactly the transaction's own amount_ngn — there is
// no admin-editable amount field anywhere in this flow, so it's
// structurally impossible to refund more than the person actually paid.
const REFUNDABLE_TYPES = new Set([
  'airtime', 'data', 'bill', 'exam_pin', 'esim', 'foreign_number',
  'nin_verification', 'nin_validation', 'bvn_verification',
  'nin_name_modification', 'nin_phone_modification', 'nin_address_modification',
  'crypto_withdraw',
]);

export function isRefundable(row: Pick<TxRow, 'type' | 'status'>): boolean {
  if (row.status !== 'pending') return false;
  if (row.type === 'crypto_withdraw') return true;
  return REFUNDABLE_TYPES.has(row.type);
}

export function formatNaira(kobo: number): string {
  return '₦' + (kobo / 100).toLocaleString('en-NG', { maximumFractionDigits: 2 });
}

// A crypto deposit has no naira value at all, and a sell is denominated in
// the coin until it settles — both store the real figure as metadata
// crypto_micro and leave amount_ngn at 0. Rendering the naira column for
// those printed "₦0" against a deposit that was actually 9.8 USDT, which
// reads as a broken or empty record rather than the amount it is.
export function formatTxAmount(row: Pick<TxRow, 'type' | 'amount_ngn' | 'metadata'>): string {
  const meta = row.metadata as { crypto_micro?: number; asset?: string } | null | undefined;
  const micro = Number(meta?.crypto_micro ?? 0);
  if (row.amount_ngn === 0 && micro > 0) {
    const asset = String(meta?.asset || '').toUpperCase() || 'crypto';
    // USDT is a dollar stablecoin, so 2dp reads naturally; a coin priced in
    // thousands needs more places before the amount stops looking like zero.
    const dp = asset === 'USDT' ? 2 : 8;
    const amount = micro / 1_000_000;
    return `${amount.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })} ${asset}`;
  }
  return formatNaira(row.amount_ngn);
}

export interface ServiceVolume {
  label: string;
  orderCount: number;
  volumeKobo: number;
}

// Collapses the raw per-type rows from admin_dashboard_report's "services"
// array into the same user-facing buckets as the Transactions page filter,
// summed and sorted highest-volume first.
export function groupServiceVolumes(rows: { type: string; order_count: number; volume_kobo: number }[]): ServiceVolume[] {
  const byLabel = new Map<string, ServiceVolume>();
  for (const row of rows) {
    const label = serviceLabelForType(row.type);
    const existing = byLabel.get(label);
    if (existing) {
      existing.orderCount += row.order_count;
      existing.volumeKobo += row.volume_kobo;
    } else {
      byLabel.set(label, { label, orderCount: row.order_count, volumeKobo: row.volume_kobo });
    }
  }
  return [...byLabel.values()].sort((a, b) => b.volumeKobo - a.volumeKobo);
}
