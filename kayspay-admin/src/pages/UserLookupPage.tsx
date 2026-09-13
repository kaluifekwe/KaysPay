import { useCallback, useState } from 'react';
import { callAdmin, AdminApiError } from '../lib/adminApi';
import ContactPhone from '../components/ContactPhone';
import { formatPhoneForAdmin } from '../lib/phone';

interface Match { id: string; full_name: string | null; phone: string | null; created_at: string; }
interface UserDetail extends Match { email: string | null; wallet_balance_kobo: number | null; wallet_locked_kobo: number | null; kyc_status: string; last_active: string | null; transaction_count: number; funding_hold_count: number; funding_hold_kobo: number; }
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

  // Manual wallet correction (see admin_wallet_correction, migration 218) --
  // for money that already moved outside the normal in-app flow, e.g. a
  // customer funded the wallet for a crypto purchase (paid by bank transfer,
  // never from the wallet), it never went through, and support already
  // refunded them manually. Deliberately not pre-filled/capped at the
  // current balance -- the server-side RPC already refuses to take a wallet
  // negative, so this stays a plain free-entry field.
  const [correctionOpen, setCorrectionOpen] = useState(false);
  const [correctionAmount, setCorrectionAmount] = useState('');
  const [correctionReason, setCorrectionReason] = useState('');
  const [correctionBusy, setCorrectionBusy] = useState(false);
  const [correctionError, setCorrectionError] = useState<string | null>(null);

  // Account deletion (see admin_delete_customer_account, migration 221) --
  // anonymizes PII/KYC and disables login while leaving transaction history
  // intact. Irreversible, so it needs a typed "DELETE" on top of the reason,
  // unlike the other admin actions on this page.
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteReason, setDeleteReason] = useState('');
  const [deleteConfirmBalance, setDeleteConfirmBalance] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

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
    setCorrectionOpen(false); setCorrectionAmount(''); setCorrectionReason(''); setCorrectionError(null);
    setDeleteOpen(false); setDeleteReason(''); setDeleteConfirmBalance(false); setDeleteConfirmText(''); setDeleteError(null);
    try {
      const response = await callAdmin<{ user: UserDetail }>('admin-user-lookup', { query: { user_id: userId, source: 'user_lookup' } });
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

  const submitCorrection = async () => {
    if (!detail) return;
    setCorrectionError(null);
    const naira = Number(correctionAmount);
    if (!Number.isFinite(naira) || naira <= 0) { setCorrectionError('Enter a valid amount'); return; }
    if (correctionReason.trim().length < 5) { setCorrectionError('A reason (at least 5 characters) is required'); return; }
    setCorrectionBusy(true);
    try {
      await callAdmin('admin-refund', {
        method: 'POST',
        body: { target: 'wallet_correction', user_id: detail.id, amount_kobo: Math.round(naira * 100), reason: correctionReason.trim() },
      });
      setCorrectionOpen(false); setCorrectionAmount(''); setCorrectionReason('');
      await openDetail(detail.id); // refresh balance + activity from the server rather than patch local state
    } catch (correctionErr) {
      setCorrectionError(correctionErr instanceof AdminApiError ? correctionErr.message : 'Could not complete the correction');
    } finally {
      setCorrectionBusy(false);
    }
  };

  const submitDelete = async () => {
    if (!detail) return;
    setDeleteError(null);
    if (deleteReason.trim().length < 5) { setDeleteError('A reason (at least 5 characters) is required'); return; }
    if (deleteConfirmText.trim() !== 'DELETE') { setDeleteError('Type DELETE to confirm'); return; }
    setDeleteBusy(true);
    try {
      await callAdmin('admin-refund', {
        method: 'POST',
        body: {
          target: 'delete_account', user_id: detail.id,
          reason: deleteReason.trim(), confirm_balance_handled: deleteConfirmBalance,
        },
      });
      setDeleteOpen(false); setDeleteReason(''); setDeleteConfirmBalance(false); setDeleteConfirmText('');
      await openDetail(detail.id); // refresh from the server so the deleted banner + wiped fields reflect reality
    } catch (deleteErr) {
      setDeleteError(deleteErr instanceof AdminApiError ? deleteErr.message : 'Could not delete this account');
    } finally {
      setDeleteBusy(false);
    }
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
          <td>{match.full_name || '—'}</td><td>{formatPhoneForAdmin(match.phone)}</td>
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
        <tr><td className="muted">Phone</td><td><ContactPhone phone={detail.phone} /></td><td className="muted">Email</td><td>{detail.email || '—'}</td></tr>
        <tr><td className="muted">Wallet balance</td><td>{formatNaira(detail.wallet_balance_kobo)} <button className="secondary" style={{ marginLeft: 10, padding: '2px 10px', fontSize: 12 }} onClick={() => setCorrectionOpen((open) => !open)}>{correctionOpen ? 'Cancel' : 'Remove funds'}</button></td><td className="muted">Locked amount</td><td>{formatNaira(detail.wallet_locked_kobo)}</td></tr>
        <tr><td className="muted">KYC status</td><td><span className={`badge ${detail.kyc_status === 'verified' ? 'enabled' : 'pending'}`}>{detail.kyc_status}</span></td><td className="muted">Transactions</td><td>{detail.transaction_count}</td></tr>
        <tr><td className="muted">Funding on KYC hold</td><td>{formatNaira(detail.funding_hold_kobo)}</td><td className="muted">Held deposits</td><td>{detail.funding_hold_count}</td></tr>
        <tr><td className="muted">Joined</td><td>{new Date(detail.created_at).toLocaleString('en-GB')}</td><td className="muted">Last active</td><td>{detail.last_active ? new Date(detail.last_active).toLocaleString('en-GB') : '—'}</td></tr>
      </tbody></table>
      {correctionOpen && <div style={{ padding: '14px 16px', borderTop: '1px solid var(--border)' }}>
        <p className="muted" style={{ marginTop: 0, marginBottom: 10, fontSize: 12.5 }}>
          Manually removes naira from this customer's wallet balance for money that already moved outside the app (e.g. a manual bank refund for a crypto purchase that never went through). Cannot exceed what's actually in the wallet. Recorded as an audited transaction and admin action.
        </p>
        <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div className="field" style={{ marginBottom: 0, width: 160 }}>
            <label>Amount (₦)</label>
            <input type="number" min="0" step="0.01" value={correctionAmount} onChange={(e) => setCorrectionAmount(e.target.value)} disabled={correctionBusy} />
          </div>
          <div className="field" style={{ marginBottom: 0, flex: 1, minWidth: 240 }}>
            <label>Reason</label>
            <input value={correctionReason} onChange={(e) => setCorrectionReason(e.target.value)} disabled={correctionBusy} placeholder="e.g. Manually refunded ₦25,000 via bank transfer for a failed crypto purchase" />
          </div>
          <button className="primary" style={{ marginTop: 20 }} disabled={correctionBusy} onClick={() => void submitCorrection()}>
            {correctionBusy ? 'Removing…' : 'Confirm removal'}
          </button>
        </div>
        {correctionError && <div className="error-text" style={{ marginTop: 8 }}>{correctionError}</div>}
      </div>}
      </div>

      {!deletedAt && <div className="card" style={{ borderColor: 'var(--error)' }}>
        <div className="row between" style={{ marginBottom: deleteOpen ? 10 : 0 }}>
          <div>
            <h4 style={{ margin: 0 }}>Delete account</h4>
            <p className="muted" style={{ margin: '4px 0 0', fontSize: 12.5 }}>
              Removes this customer's name, phone, PIN, biometric setting, KYC/BVN/NIN data, saved billing accounts,
              push token and funding account, and disables their login. Transaction history is kept, dissociated
              from their identity, for the regulatory retention period. This cannot be undone.
            </p>
          </div>
          {!deleteOpen && <button className="danger" style={{ flexShrink: 0 }} onClick={() => setDeleteOpen(true)}>Delete account</button>}
        </div>
        {deleteOpen && <div>
          {(detail.wallet_balance_kobo ?? 0) !== 0 || (detail.wallet_locked_kobo ?? 0) !== 0
            ? <p className="error-text" style={{ marginTop: 0, fontSize: 12.5 }}>
                This wallet still holds {formatNaira(detail.wallet_balance_kobo)}
                {(detail.wallet_locked_kobo ?? 0) !== 0 && ` (plus ${formatNaira(detail.wallet_locked_kobo)} locked)`}.
                Handle it first, then check the box below to confirm before deleting.
              </p>
            : null}
          <div className="field">
            <label>Reason (required)</label>
            <input value={deleteReason} onChange={(e) => setDeleteReason(e.target.value)} disabled={deleteBusy} placeholder="e.g. Customer emailed requesting account deletion on 11 Sept 2026" autoFocus />
          </div>
          <label className="row" style={{ gap: 8, alignItems: 'center', fontSize: 12.5, marginBottom: 10 }}>
            <input type="checkbox" checked={deleteConfirmBalance} onChange={(e) => setDeleteConfirmBalance(e.target.checked)} disabled={deleteBusy} style={{ width: 'auto' }} />
            Any wallet balance has already been withdrawn or otherwise handled outside this deletion
          </label>
          <div className="field">
            <label>Type DELETE to confirm</label>
            <input value={deleteConfirmText} onChange={(e) => setDeleteConfirmText(e.target.value)} disabled={deleteBusy} style={{ maxWidth: 160 }} />
          </div>
          {deleteError && <div className="error-text" style={{ marginBottom: 8 }}>{deleteError}</div>}
          <div className="row" style={{ gap: 8 }}>
            <button className="danger" disabled={deleteBusy} onClick={() => void submitDelete()}>
              {deleteBusy ? 'Deleting…' : 'Confirm deletion'}
            </button>
            <button className="secondary" disabled={deleteBusy} onClick={() => { setDeleteOpen(false); setDeleteError(null); }}>Cancel</button>
          </div>
        </div>}
      </div>}

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
