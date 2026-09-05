import { useEffect, useMemo, useState } from 'react';
import { callAdmin, AdminApiError } from '../lib/adminApi';
import { formatFundingProvider, formatTxAmount, SERVICES, truncateAddress, TxRow } from '../lib/transactions';
import TransactionDetailModal from '../components/TransactionDetailModal';
import { useHidden, HIDDEN_MASK } from '../lib/hidden';

interface TxResponse {
  transactions: TxRow[];
  total: number;
  page: number;
  page_size: number;
}

const STATUSES = ['', 'pending', 'completed', 'failed', 'refunded'];

// crypto_sell/crypto_withdraw/crypto_buy store the asset code (e.g. "USDT")
// in recipient_phone, not an actual phone number -- never personal data, so
// it's excluded from the recipient-number mask below regardless of the
// toggle.
const CRYPTO_TYPES = new Set(['crypto_buy', 'crypto_sell', 'crypto_withdraw']);

// admin-transactions already reads and applies date_from/date_to server-side
// (created_at gte/lte) — this was purely a missing UI, the backend was ready.
// Same range-picker convention as DashboardPage, so "7 days" means the same
// thing on both pages.
type RangeKey = 'all' | 'today' | '7d' | '30d' | 'custom';
const RANGE_LABELS: { key: RangeKey; label: string }[] = [
  { key: 'all', label: 'All time' },
  { key: 'today', label: 'Today' },
  { key: '7d', label: '7 days' },
  { key: '30d', label: '30 days' },
  { key: 'custom', label: 'Custom range' },
];
function toDateInputValue(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export default function TransactionsPage() {
  const [rows, setRows] = useState<TxRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [service, setService] = useState(''); // SERVICES label, or '' for all
  const [status, setStatus] = useState('');
  const [phoneInput, setPhoneInput] = useState('');
  const [phone, setPhone] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<TxRow | null>(null);
  const [namesHidden, toggleNamesHidden] = useHidden('transactions:names');
  const [recipientsHidden, toggleRecipientsHidden] = useHidden('transactions:recipients');
  // Defaults to 'all' (no date restriction) rather than mirroring Dashboard's
  // 30-day default — this page is also used to look up a specific phone
  // number's full history, so the safer default is the one that matches
  // today's existing behavior exactly until someone deliberately narrows it.
  const [range, setRange] = useState<RangeKey>('all');
  const [customStart, setCustomStart] = useState(toDateInputValue(new Date(Date.now() - 7 * 86400000)));
  const [customEnd, setCustomEnd] = useState(toDateInputValue(new Date()));

  const { dateFrom, dateTo } = useMemo(() => {
    if (range === 'all') return { dateFrom: null as Date | null, dateTo: null as Date | null };
    const now = new Date();
    if (range === 'today') {
      const s = new Date(now); s.setHours(0, 0, 0, 0);
      return { dateFrom: s, dateTo: now };
    }
    if (range === '7d') return { dateFrom: new Date(now.getTime() - 7 * 86400000), dateTo: now };
    if (range === '30d') return { dateFrom: new Date(now.getTime() - 30 * 86400000), dateTo: now };
    // custom: end of the selected end-date, so it includes that whole day
    return { dateFrom: new Date(customStart + 'T00:00:00'), dateTo: new Date(customEnd + 'T23:59:59.999') };
  }, [range, customStart, customEnd]);

  // Debounce the phone search so every keystroke doesn't fire a request.
  useEffect(() => {
    const t = setTimeout(() => { setPhone(phoneInput); setPage(0); }, 400);
    return () => clearTimeout(t);
  }, [phoneInput]);

  const load = () => {
    setLoading(true);
    setError(null);
    const types = SERVICES.find((s) => s.label === service)?.types.join(',') ?? '';
    callAdmin<TxResponse>('admin-transactions', {
      query: {
        page: String(page), status, phone, types,
        date_from: dateFrom ? dateFrom.toISOString() : '',
        date_to: dateTo ? dateTo.toISOString() : '',
      },
    })
      .then((r) => {
        setRows(r.transactions);
        setTotal(r.total);
      })
      .catch((e) => setError(e instanceof AdminApiError ? e.message : 'Could not load transactions'))
      .finally(() => setLoading(false));
  };

  useEffect(load, [page, status, phone, service, dateFrom, dateTo]);

  const pageSize = 50;
  const maxPage = Math.max(0, Math.ceil(total / pageSize) - 1);

  return (
    <div>
      <div className="row between" style={{ marginBottom: 16, flexWrap: 'wrap', gap: 12 }}>
        <h2 style={{ margin: 0 }}>Transactions</h2>
        <div className="range-picker">
          {RANGE_LABELS.map((r) => (
            <div
              key={r.key}
              className={`range-pill ${range === r.key ? 'active' : ''}`}
              onClick={() => { setRange(r.key); setPage(0); }}
            >
              {r.label}
            </div>
          ))}
        </div>
      </div>

      {range === 'custom' && (
        <div className="row" style={{ gap: 12, marginBottom: 16 }}>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>From</label>
            <input type="date" value={customStart} onChange={(e) => { setCustomStart(e.target.value); setPage(0); }} />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>To</label>
            <input type="date" value={customEnd} onChange={(e) => { setCustomEnd(e.target.value); setPage(0); }} />
          </div>
        </div>
      )}

      <div className="row" style={{ marginBottom: 16, gap: 12 }}>
        <select value={service} onChange={(e) => { setService(e.target.value); setPage(0); }} style={{ width: 220 }}>
          <option value="">All services</option>
          {SERVICES.map((s) => <option key={s.label} value={s.label}>{s.label}</option>)}
        </select>
        <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(0); }} style={{ width: 160 }}>
          {STATUSES.map((s) => <option key={s} value={s}>{s || 'All statuses'}</option>)}
        </select>
        <input
          placeholder="Search by recipient phone"
          value={phoneInput}
          onChange={(e) => setPhoneInput(e.target.value)}
          style={{ width: 240 }}
        />
        <button
          type="button"
          className="secondary"
          onClick={toggleNamesHidden}
          style={{ marginLeft: 'auto' }}
        >
          {namesHidden ? '🙈 Names hidden' : '👁️ Hide customer names'}
        </button>
        <button
          type="button"
          className="secondary"
          onClick={toggleRecipientsHidden}
        >
          {recipientsHidden ? '🙈 Recipients hidden' : '👁️ Hide recipient numbers'}
        </button>
      </div>

      {error && <div className="error-text">{error}</div>}

      <div className="card">
        {loading ? (
          <p className="muted">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="muted">No transactions match this filter.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>User</th>
                <th>Type</th>
                <th>Recipient</th>
                <th>Amount</th>
                <th>Status</th>
                <th>Order ref</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="clickable" onClick={() => setSelected(r)}>
                  <td>{new Date(r.created_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
                  <td>{namesHidden ? HIDDEN_MASK : (r.users?.full_name || r.users?.phone || '—')}</td>
                  <td>{r.type}</td>
                  <td>{r.type === 'wallet_fund'
                    ? formatFundingProvider(r.funding_provider)
                    : <>{recipientsHidden && !CRYPTO_TYPES.has(r.type)
                        ? (r.recipient_phone ? HIDDEN_MASK : '—')
                        : (r.recipient_phone ? (r.type === 'crypto_withdraw' ? truncateAddress(r.recipient_phone) : r.recipient_phone) : '—')}{r.network ? ` (${r.network})` : ''}</>}</td>
                  <td>{formatTxAmount(r)}</td>
                  <td>{(() => {
                    const status = r.service_refunds?.length ? 'refunded' : r.status;
                    // An abandoned checkout is stored as 'failed' because the
                    // status column only allows four values, but nothing
                    // actually failed — the customer was issued a payment
                    // account and never transferred. Showing those as
                    // failures made the dashboard look like the product was
                    // breaking when it was not.
                    const notPaid = status === 'failed'
                      && (r.metadata as { failure_reason?: string } | null)?.failure_reason === 'not_paid';
                    return notPaid
                      ? <span className="badge pending" title="Payment account was issued but the customer never transferred">not paid</span>
                      : <span className={`badge ${status}`}>{status}</span>;
                  })()}</td>
                  <td className="muted">{r.type === 'wallet_fund'
                    ? (r.funding_reference || '—')
                    : (r.vtu_order_id || '—')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="pagination">
        <button className="secondary" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}>Previous</button>
        <span className="muted">Page {page + 1} of {maxPage + 1} · {total} total</span>
        <button className="secondary" onClick={() => setPage((p) => Math.min(maxPage, p + 1))} disabled={page >= maxPage}>Next</button>
      </div>

      {selected && (
        <TransactionDetailModal
          transaction={selected}
          onClose={() => setSelected(null)}
          onRefunded={() => { load(); }}
        />
      )}
    </div>
  );
}
