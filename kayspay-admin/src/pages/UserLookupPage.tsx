import { useState } from 'react';
import { callAdmin, AdminApiError } from '../lib/adminApi';

interface Match {
  id: string;
  full_name: string | null;
  phone: string | null;
  created_at: string;
}

interface UserDetail extends Match {
  email: string | null;
  wallet_balance_kobo: number | null;
  wallet_locked_kobo: number | null;
  kyc_status: string;
  last_active: string | null;
  transaction_count: number;
}

function formatNaira(kobo: number | null): string {
  if (kobo === null) return '—';
  return '₦' + (kobo / 100).toLocaleString('en-NG', { maximumFractionDigits: 2 });
}

export default function UserLookupPage() {
  const [q, setQ] = useState('');
  const [matches, setMatches] = useState<Match[]>([]);
  const [detail, setDetail] = useState<UserDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const search = async () => {
    setError(null);
    setDetail(null);
    if (q.trim().length < 3) {
      setError('Enter at least 3 characters');
      return;
    }
    setLoading(true);
    try {
      const r = await callAdmin<{ matches: Match[] }>('admin-user-lookup', { query: { q } });
      setMatches(r.matches);
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : 'Search failed');
    } finally {
      setLoading(false);
    }
  };

  const openDetail = async (userId: string) => {
    setError(null);
    setLoading(true);
    try {
      const r = await callAdmin<{ user: UserDetail }>('admin-user-lookup', { query: { user_id: userId } });
      setDetail(r.user);
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : 'Could not load user');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <h2>User Lookup</h2>

      <div className="row" style={{ gap: 12, marginBottom: 16 }}>
        <input
          placeholder="Search by phone or name"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && search()}
          style={{ maxWidth: 320 }}
        />
        <button className="primary" onClick={search} disabled={loading}>Search</button>
      </div>

      {error && <div className="error-text">{error}</div>}

      {!detail && matches.length > 0 && (
        <div className="card">
          <table>
            <thead><tr><th>Name</th><th>Phone</th><th>Joined</th><th /></tr></thead>
            <tbody>
              {matches.map((m) => (
                <tr key={m.id}>
                  <td>{m.full_name || '—'}</td>
                  <td>{m.phone || '—'}</td>
                  <td>{new Date(m.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</td>
                  <td><button className="secondary" onClick={() => openDetail(m.id)}>View</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {detail && (
        <div className="card">
          <div className="row between">
            <h3 style={{ marginTop: 0 }}>{detail.full_name || 'Unnamed user'}</h3>
            <button className="secondary" onClick={() => setDetail(null)}>Back to results</button>
          </div>
          <table>
            <tbody>
              <tr><td className="muted">Phone</td><td>{detail.phone || '—'}</td></tr>
              <tr><td className="muted">Email</td><td>{detail.email || '—'}</td></tr>
              <tr><td className="muted">Wallet balance</td><td>{formatNaira(detail.wallet_balance_kobo)}</td></tr>
              <tr><td className="muted">Locked amount</td><td>{formatNaira(detail.wallet_locked_kobo)}</td></tr>
              <tr><td className="muted">KYC status</td><td><span className={`badge ${detail.kyc_status === 'verified' ? 'enabled' : 'pending'}`}>{detail.kyc_status}</span></td></tr>
              <tr><td className="muted">Transactions</td><td>{detail.transaction_count}</td></tr>
              <tr><td className="muted">Joined</td><td>{new Date(detail.created_at).toLocaleString('en-GB')}</td></tr>
              <tr><td className="muted">Last active</td><td>{detail.last_active ? new Date(detail.last_active).toLocaleString('en-GB') : '—'}</td></tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
