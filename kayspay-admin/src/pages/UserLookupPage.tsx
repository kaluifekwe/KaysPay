import { useCallback, useState } from 'react';
import { callAdmin, AdminApiError } from '../lib/adminApi';

interface Match { id: string; full_name: string | null; phone: string | null; created_at: string; }
interface UserDetail extends Match { email: string | null; wallet_balance_kobo: number | null; wallet_locked_kobo: number | null; kyc_status: string; last_active: string | null; transaction_count: number; }
type ActivityCategory = '' | 'account' | 'financial' | 'security' | 'service' | 'admin';
interface ActivityEvent {
  event_key: string; occurred_at: string; category: Exclude<ActivityCategory, ''>;
  event_type: string; outcome: string | null; source: string; entity_type: string | null;
  entity_id: string | null; summary: string; metadata: Record<string, unknown>;
  actor_type: 'customer' | 'admin' | 'system' | 'provider';
}
interface ActivityResponse {
  activities: ActivityEvent[]; next_cursor: string | null;
  subject: { subject_id: string; joined_at: string; deleted_at: string | null };
}
interface ActivityFilters { from: string; to: string; category: ActivityCategory; outcome: string; }
const EMPTY_FILTERS: ActivityFilters = { from: '', to: '', category: '', outcome: '' };

function formatNaira(kobo: number | null): string {
  if (kobo === null) return '—';
  return '₦' + (kobo / 100).toLocaleString('en-NG', { maximumFractionDigits: 2 });
}

function formatMetadata(metadata: Record<string, unknown>): string {
  return Object.entries(metadata)
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([key, value]) => {
      const label = key.replace(/_/g, ' ');
      if (key.endsWith('_kobo') && typeof value === 'number') return `${label.replace(' kobo', '')}: ${formatNaira(value)}`;
      return `${label}: ${String(value)}`;
    }).join(' · ');
}

function toStartOfDay(value: string): string { return value ? new Date(`${value}T00:00:00`).toISOString() : ''; }
function toEndOfDay(value: string): string { return value ? new Date(`${value}T23:59:59.999`).toISOString() : ''; }

export default function UserLookupPage() {
  const [q, setQ] = useState('');
  const [matches, setMatches] = useState<Match[]>([]);
  const [detail, setDetail] = useState<UserDetail | null>(null);
  const [activities, setActivities] = useState<ActivityEvent[]>([]);
  const [filters, setFilters] = useState<ActivityFilters>(EMPTY_FILTERS);
  const [appliedFilters, setAppliedFilters] = useState<ActivityFilters>(EMPTY_FILTERS);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [deletedAt, setDeletedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [activityLoading, setActivityLoading] = useState(false);

  const loadActivity = useCallback(async (userId: string, requestedFilters: ActivityFilters, before: string | null = null) => {
    setActivityLoading(true); setError(null);
    try {
      const response = await callAdmin<ActivityResponse>('admin-user-activity', { query: {
        user_id: userId, from: toStartOfDay(requestedFilters.from), to: toEndOfDay(requestedFilters.to),
        category: requestedFilters.category, outcome: requestedFilters.outcome, before: before || '',
      } });
      setActivities((current) => before ? [...current, ...response.activities] : response.activities);
      setNextCursor(response.next_cursor); setDeletedAt(response.subject.deleted_at);
    } catch (activityError) {
      setError(activityError instanceof AdminApiError ? activityError.message : 'Could not load customer activity');
    } finally { setActivityLoading(false); }
  }, []);

  const search = async () => {
    setError(null); setDetail(null); setActivities([]);
    if (q.trim().length < 3) { setError('Enter at least 3 characters'); return; }
    setLoading(true);
    try {
      const response = await callAdmin<{ matches: Match[] }>('admin-user-lookup', { query: { q } });
      setMatches(response.matches);
    } catch (searchError) { setError(searchError instanceof AdminApiError ? searchError.message : 'Search failed'); }
    finally { setLoading(false); }
  };

  const openDetail = async (userId: string) => {
    setError(null); setLoading(true); setActivities([]); setFilters(EMPTY_FILTERS); setAppliedFilters(EMPTY_FILTERS);
    try {
      const response = await callAdmin<{ user: UserDetail }>('admin-user-lookup', { query: { user_id: userId } });
      setDetail(response.user); await loadActivity(userId, EMPTY_FILTERS);
    } catch (detailError) { setError(detailError instanceof AdminApiError ? detailError.message : 'Could not load user'); }
    finally { setLoading(false); }
  };

  const applyFilters = async () => {
    if (!detail) return;
    if (filters.from && filters.to && filters.from > filters.to) { setError('Start date must be before end date'); return; }
    setAppliedFilters(filters); await loadActivity(detail.id, filters);
  };
  const clearFilters = async () => {
    if (!detail) return;
    setFilters(EMPTY_FILTERS); setAppliedFilters(EMPTY_FILTERS); await loadActivity(detail.id, EMPTY_FILTERS);
  };

  return <div>
    <h2>User Lookup</h2>
    {!detail && <>
      <div className="row" style={{ gap: 12, marginBottom: 16 }}>
        <input placeholder="Search by phone or name" value={q} onChange={(event) => setQ(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && void search()} style={{ maxWidth: 320 }} />
        <button className="primary" onClick={() => void search()} disabled={loading}>Search</button>
      </div>
      {matches.length > 0 && <div className="card table-scroll"><table>
        <thead><tr><th>Name</th><th>Phone</th><th>Joined</th><th /></tr></thead>
        <tbody>{matches.map((match) => <tr key={match.id}>
          <td>{match.full_name || '—'}</td><td>{match.phone || '—'}</td>
          <td>{new Date(match.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</td>
          <td><button className="secondary" onClick={() => void openDetail(match.id)}>View</button></td>
        </tr>)}</tbody>
      </table></div>}
    </>}
    {error && <div className="error-text" style={{ marginBottom: 16 }}>{error}</div>}

    {detail && <>
      <div className="row between" style={{ marginBottom: 16 }}>
        <div><h2 style={{ marginBottom: 4 }}>{detail.full_name || 'Unnamed user'}</h2><div className="muted mono">{detail.id}</div></div>
        <button className="secondary" onClick={() => { setDetail(null); setActivities([]); }}>Back to results</button>
      </div>
      {deletedAt && <div className="error-text" style={{ marginBottom: 16 }}>Account deleted on {new Date(deletedAt).toLocaleString('en-GB')}. Retained records are read-only.</div>}
      <div className="card table-scroll"><table><tbody>
        <tr><td className="muted">Phone</td><td>{detail.phone || '—'}</td><td className="muted">Email</td><td>{detail.email || '—'}</td></tr>
        <tr><td className="muted">Wallet balance</td><td>{formatNaira(detail.wallet_balance_kobo)}</td><td className="muted">Locked amount</td><td>{formatNaira(detail.wallet_locked_kobo)}</td></tr>
        <tr><td className="muted">KYC status</td><td><span className={`badge ${detail.kyc_status === 'verified' ? 'enabled' : 'pending'}`}>{detail.kyc_status}</span></td><td className="muted">Transactions</td><td>{detail.transaction_count}</td></tr>
        <tr><td className="muted">Joined</td><td>{new Date(detail.created_at).toLocaleString('en-GB')}</td><td className="muted">Last active</td><td>{detail.last_active ? new Date(detail.last_active).toLocaleString('en-GB') : '—'}</td></tr>
      </tbody></table></div>

      <div className="activity-heading"><h2>Activity Timeline</h2><p className="muted">Server-recorded customer, financial, security, service, and admin events.</p></div>
      <div className="activity-filters">
        <label>From<input type="date" value={filters.from} onChange={(event) => setFilters({ ...filters, from: event.target.value })} /></label>
        <label>To<input type="date" value={filters.to} onChange={(event) => setFilters({ ...filters, to: event.target.value })} /></label>
        <label>Category<select value={filters.category} onChange={(event) => setFilters({ ...filters, category: event.target.value as ActivityCategory })}>
          <option value="">All categories</option><option value="account">Account</option><option value="financial">Financial</option><option value="security">Security</option><option value="service">Service</option><option value="admin">Admin</option>
        </select></label>
        <label>Outcome<select value={filters.outcome} onChange={(event) => setFilters({ ...filters, outcome: event.target.value })}>
          <option value="">All outcomes</option><option value="pending">Pending</option><option value="completed">Completed</option><option value="failed">Failed</option><option value="refunded">Refunded</option><option value="blocked">Blocked</option><option value="recorded">Recorded</option>
        </select></label>
        <div className="row activity-filter-actions"><button className="primary" onClick={() => void applyFilters()} disabled={activityLoading}>Apply</button><button className="secondary" onClick={() => void clearFilters()} disabled={activityLoading}>Clear</button></div>
      </div>

      <div className="activity-list" aria-live="polite">
        {!activityLoading && activities.length === 0 && <div className="card"><p className="muted">No activity matches these filters.</p></div>}
        {activities.map((activity) => {
          const details = formatMetadata(activity.metadata);
          return <article className="activity-item" key={activity.event_key}>
            <div className={`activity-marker ${activity.category}`} />
            <div className="activity-content">
              <div className="row between activity-title-row"><strong>{activity.summary}</strong><time>{new Date(activity.occurred_at).toLocaleString('en-GB')}</time></div>
              <div className="activity-meta"><span className={`badge ${activity.outcome || 'recorded'}`}>{activity.outcome || 'recorded'}</span><span>{activity.category}</span><span>{activity.source}</span><span>{activity.actor_type}</span></div>
              {details && <div className="muted activity-details">{details}</div>}
              {activity.entity_id && <div className="mono muted activity-reference">{activity.entity_type}: {activity.entity_id}</div>}
            </div>
          </article>;
        })}
        {activityLoading && <div className="card"><p className="muted">Loading activity…</p></div>}
      </div>
      {nextCursor && <button className="secondary" disabled={activityLoading} onClick={() => void loadActivity(detail.id, appliedFilters, nextCursor)}>Load older activity</button>}
    </>}
  </div>;
}
