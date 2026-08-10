import { useEffect, useState } from 'react';
import { callAdmin, AdminApiError } from '../lib/adminApi';
import { formatNaira, SERVICES, TxRow } from '../lib/transactions';
import TransactionDetailModal from '../components/TransactionDetailModal';

interface TxResponse {
  transactions: TxRow[];
  total: number;
  page: number;
  page_size: number;
}

const STATUSES = ['', 'pending', 'completed', 'failed', 'refunded'];

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

  // Debounce the phone search so every keystroke doesn't fire a request.
  useEffect(() => {
    const t = setTimeout(() => { setPhone(phoneInput); setPage(0); }, 400);
    return () => clearTimeout(t);
  }, [phoneInput]);

  const load = () => {
    setLoading(true);
    setError(null);
    const types = SERVICES.find((s) => s.label === service)?.types.join(',') ?? '';
    callAdmin<TxResponse>('admin-transactions', { query: { page: String(page), status, phone, types } })
      .then((r) => {
        setRows(r.transactions);
        setTotal(r.total);
      })
      .catch((e) => setError(e instanceof AdminApiError ? e.message : 'Could not load transactions'))
      .finally(() => setLoading(false));
  };

  useEffect(load, [page, status, phone, service]);

  const pageSize = 50;
  const maxPage = Math.max(0, Math.ceil(total / pageSize) - 1);

  return (
    <div>
      <h2>Transactions</h2>

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
                  <td>{r.users?.full_name || r.users?.phone || '—'}</td>
                  <td>{r.type}</td>
                  <td>{r.recipient_phone || '—'}{r.network ? ` (${r.network})` : ''}</td>
                  <td>{formatNaira(r.amount_ngn)}</td>
                  <td>{(() => {
                    const status = r.service_refunds?.length ? 'refunded' : r.status;
                    return <span className={`badge ${status}`}>{status}</span>;
                  })()}</td>
                  <td className="muted">{r.vtu_order_id || '—'}</td>
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
