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
