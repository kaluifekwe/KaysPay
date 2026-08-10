import { useCallback, useEffect, useMemo, useState } from 'react';
import { AdminApiError, callAdmin } from '../lib/adminApi';
import { useAuth } from '../AuthContext';

type AlertStatus = 'open' | 'acknowledged' | 'resolved';
interface SecurityAlert {
  fingerprint: string;
  alert_type: string;
  severity: 'warning' | 'critical';
  details: Record<string, unknown>;
  occurrence_count: number;
  first_seen_at: string;
  last_seen_at: string;
  status: AlertStatus;
  resolution_notes: string | null;
}
interface SecurityEvent {
  id: number;
  user_id: string | null;
  event_type: string;
  severity: 'info' | 'warning' | 'critical';
  source: string;
  metadata: Record<string, unknown>;
  created_at: string;
}
interface SecurityCase {
  id: string;
  user_id: string;
  severity: 'warning' | 'critical';
  status: 'open' | 'resolved';
  summary: string;
  created_at: string;
  resolved_at: string | null;
}
interface FinancialRestriction {
  id: string;
  case_id: string;
  user_id: string;
  status: 'active' | 'lifted';
  reason: string;
  imposed_at: string;
  lifted_at: string | null;
  reverification_method: string | null;
}
interface ResponsePayload {
  alerts: SecurityAlert[];
  total: number;
  page: number;
  page_size: number;
  status_counts: Record<AlertStatus, number>;
  monitor: {
    healthy: boolean;
    last_success_at: string | null;
    last_failure_at: string | null;
    last_email_at: string | null;
    consecutive_failures: number;
    age_seconds: number | null;
  };
  recent_events: SecurityEvent[];
  security_cases: SecurityCase[];
  financial_restrictions: FinancialRestriction[];
}

const formatDate = (value: string | null) => value
  ? new Date(value).toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' })
  : 'Never';

export default function SecurityAlertsPage() {
  const { role } = useAuth();
  const [data, setData] = useState<ResponsePayload | null>(null);
  const [status, setStatus] = useState<'all' | AlertStatus>('open');
  const [severity, setSeverity] = useState('');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<SecurityAlert | null>(null);
  const [notes, setNotes] = useState('');
  const [responseTarget, setResponseTarget] = useState<{ userId: string; restrictionId?: string } | null>(null);
  const [responseAction, setResponseAction] = useState<'restrict_financial' | 'lift_restriction' | 'revoke_sessions'>('revoke_sessions');
  const [responseSummary, setResponseSummary] = useState('');
  const [responseNotes, setResponseNotes] = useState('');
  const [override, setOverride] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await callAdmin<ResponsePayload>('admin-security-alerts', {
        query: { status, severity, page: String(page) },
      });
      setData(result);
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : 'Could not load security alerts');
    } finally {
      setLoading(false);
    }
  }, [page, severity, status]);

  useEffect(() => { void load(); }, [load]);

  const pages = useMemo(() => Math.max(Math.ceil((data?.total || 0) / (data?.page_size || 30)), 1), [data]);

  const updateAlert = async (alert: SecurityAlert, action: 'acknowledge' | 'resolve' | 'reopen') => {
    setBusy(alert.fingerprint);
    setError(null);
    try {
      await callAdmin('admin-security-alerts', {
        method: 'POST', body: { fingerprint: alert.fingerprint, action, notes },
      });
      setSelected(null);
      setNotes('');
      await load();
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : 'Could not update alert');
    } finally {
      setBusy(null);
    }
  };

  const applyResponse = async () => {
    if (!responseTarget) return;
    setBusy(responseTarget.restrictionId || responseTarget.userId);
    setError(null);
    try {
      await callAdmin('admin-security-alerts', {
        method: 'POST',
        body: {
          action: responseAction,
          user_id: responseTarget.userId,
          restriction_id: responseTarget.restrictionId,
          summary: responseSummary,
          notes: responseNotes,
          override,
        },
      });
      setResponseTarget(null);
      setResponseSummary('');
      setResponseNotes('');
      setOverride(false);
      await load();
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : 'Could not apply security response');
    } finally {
      setBusy(null);
    }
  };

  const openResponse = (
    userId: string,
    action: 'restrict_financial' | 'lift_restriction' | 'revoke_sessions',
    restrictionId?: string,
  ) => {
    setResponseTarget({ userId, restrictionId });
    setResponseAction(action);
    setResponseSummary(action === 'restrict_financial'
      ? 'Suspicious account activity investigation'
      : action === 'revoke_sessions' ? 'Security session reset' : 'Security verification completed');
    setResponseNotes('');
    setOverride(false);
  };

  return (
    <div>
      <div className="row between">
        <div><h2>Security Operations</h2><p className="muted">Observation and response records. No account is suspended automatically.</p></div>
        <button className="secondary" onClick={() => void load()} disabled={loading}>Refresh</button>
      </div>
      {error && <div className="error-text">{error}</div>}

      <div className="stat-grid" style={{ marginBottom: 20 }}>
        <div className={`stat ${data?.monitor.healthy ? 'accent' : 'alert-stat'}`}>
          <div className="value">{data?.monitor.healthy ? 'Healthy' : 'Stale'}</div>
          <div className="label">Monitor · last success {formatDate(data?.monitor.last_success_at || null)} · last email {formatDate(data?.monitor.last_email_at || null)}</div>
        </div>
        <div className="stat"><div className="value">{data?.status_counts.open ?? '—'}</div><div className="label">Open alerts</div></div>
        <div className="stat"><div className="value">{data?.status_counts.acknowledged ?? '—'}</div><div className="label">Acknowledged</div></div>
        <div className="stat"><div className="value">{data?.status_counts.resolved ?? '—'}</div><div className="label">Resolved</div></div>
      </div>

      <div className="row" style={{ marginBottom: 12 }}>
        <select aria-label="Alert status" value={status} onChange={(e) => { setStatus(e.target.value as typeof status); setPage(1); }} style={{ maxWidth: 190 }}>
          <option value="open">Open</option><option value="acknowledged">Acknowledged</option><option value="resolved">Resolved</option><option value="all">All statuses</option>
        </select>
        <select aria-label="Alert severity" value={severity} onChange={(e) => { setSeverity(e.target.value); setPage(1); }} style={{ maxWidth: 190 }}>
          <option value="">All severities</option><option value="critical">Critical</option><option value="warning">Warning</option>
        </select>
      </div>

      <div className="card table-scroll">
        {loading ? <p className="muted">Loading…</p> : !data?.alerts.length ? <p className="muted">No alerts match this filter.</p> : (
          <table><thead><tr><th>Alert</th><th>Severity</th><th>Count</th><th>Last seen</th><th>Status</th><th /></tr></thead>
            <tbody>{data.alerts.map((alert) => <tr key={alert.fingerprint}>
              <td><strong>{alert.alert_type}</strong><div className="muted">{alert.fingerprint}</div></td>
              <td><span className={`badge ${alert.severity}`}>{alert.severity}</span></td>
              <td>{alert.occurrence_count}</td><td>{formatDate(alert.last_seen_at)}</td>
              <td><span className={`badge ${alert.status}`}>{alert.status}</span></td>
              <td><button className="secondary" onClick={() => { setSelected(alert); setNotes(alert.resolution_notes || ''); }}>Review</button></td>
            </tr>)}</tbody>
          </table>
        )}
      </div>
      <div className="pagination">
        <button className="secondary" disabled={page <= 1 || loading} onClick={() => setPage((p) => p - 1)}>Previous</button>
        <span className="muted">Page {page} of {pages}</span>
        <button className="secondary" disabled={page >= pages || loading} onClick={() => setPage((p) => p + 1)}>Next</button>
      </div>

      <h2 style={{ marginTop: 32 }}>Recent Security Activity</h2>
      <div className="card table-scroll">
        {!data?.recent_events.length ? <p className="muted">No recent security events.</p> : <table>
          <thead><tr><th>Time</th><th>Event</th><th>Source</th><th>User reference</th><th>Details</th>{role === 'super_admin' && <th />}</tr></thead>
          <tbody>{data.recent_events.map((event) => <tr key={event.id}>
            <td>{formatDate(event.created_at)}</td><td>{event.event_type.replace(/_/g, ' ')}</td><td>{event.source}</td>
            <td className="mono">{event.user_id ? event.user_id.slice(0, 8) : '—'}</td>
            <td className="muted">{Object.entries(event.metadata).map(([key, value]) => `${key}: ${String(value)}`).join(' · ') || '—'}</td>
            {role === 'super_admin' && <td>{event.user_id && <button className="secondary" onClick={() => openResponse(event.user_id!, 'revoke_sessions')}>Respond</button>}</td>}
          </tr>)}</tbody>
        </table>}
      </div>

      <h2 style={{ marginTop: 32 }}>Financial Restrictions</h2>
      <div className="card table-scroll">
        {!data?.financial_restrictions.length ? <p className="muted">No financial restrictions recorded.</p> : <table>
          <thead><tr><th>Customer reference</th><th>Status</th><th>Applied</th><th>Reason</th><th>Verification</th>{role === 'super_admin' && <th />}</tr></thead>
          <tbody>{data.financial_restrictions.map((restriction) => <tr key={restriction.id}>
            <td className="mono">{restriction.user_id.slice(0, 8)}</td>
            <td><span className={`badge ${restriction.status === 'active' ? 'open' : 'resolved'}`}>{restriction.status}</span></td>
            <td>{formatDate(restriction.imposed_at)}</td><td>{restriction.reason}</td>
            <td className="muted">{restriction.reverification_method?.replace(/_/g, ' ') || 'Pending'}</td>
            {role === 'super_admin' && <td>{restriction.status === 'active' && <button className="primary" onClick={() => openResponse(restriction.user_id, 'lift_restriction', restriction.id)}>Review removal</button>}</td>}
          </tr>)}</tbody>
        </table>}
      </div>

      <h2 style={{ marginTop: 32 }}>Security Cases</h2>
      <div className="card table-scroll">
        {!data?.security_cases.length ? <p className="muted">No security cases recorded.</p> : <table>
          <thead><tr><th>Created</th><th>Customer reference</th><th>Summary</th><th>Severity</th><th>Status</th></tr></thead>
          <tbody>{data.security_cases.map((securityCase) => <tr key={securityCase.id}>
            <td>{formatDate(securityCase.created_at)}</td><td className="mono">{securityCase.user_id.slice(0, 8)}</td><td>{securityCase.summary}</td>
            <td><span className={`badge ${securityCase.severity}`}>{securityCase.severity}</span></td>
            <td><span className={`badge ${securityCase.status === 'open' ? 'open' : 'resolved'}`}>{securityCase.status}</span></td>
          </tr>)}</tbody>
        </table>}
      </div>

      {selected && <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Review security alert">
        <div className="modal-card"><h2>{selected.alert_type}</h2>
          <p><span className={`badge ${selected.severity}`}>{selected.severity}</span> · seen {selected.occurrence_count} time(s)</p>
          <p className="muted">First: {formatDate(selected.first_seen_at)}<br />Latest: {formatDate(selected.last_seen_at)}</p>
          <div className="field"><label htmlFor="resolution-notes">Investigation / resolution notes</label>
            <textarea id="resolution-notes" value={notes} maxLength={500} onChange={(e) => setNotes(e.target.value)} placeholder="What was checked and what resolved it?" />
          </div>
          <div className="row">
            {selected.status === 'open' && <button className="secondary" disabled={busy === selected.fingerprint} onClick={() => void updateAlert(selected, 'acknowledge')}>Acknowledge</button>}
            {selected.status !== 'resolved' && <button className="primary" disabled={busy === selected.fingerprint || notes.trim().length < 3} onClick={() => void updateAlert(selected, 'resolve')}>Resolve</button>}
            {selected.status === 'resolved' && <button className="secondary" disabled={busy === selected.fingerprint} onClick={() => void updateAlert(selected, 'reopen')}>Reopen</button>}
            <button className="secondary" onClick={() => { setSelected(null); setNotes(''); }}>Close</button>
          </div>
        </div>
      </div>}

      {responseTarget && <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Apply security response">
        <div className="modal-card">
          <h2>Security Response</h2>
          <p className="muted">Customer reference: <span className="mono">{responseTarget.userId.slice(0, 8)}</span></p>
          {!responseTarget.restrictionId && <div className="field"><label htmlFor="response-action">Action</label>
            <select id="response-action" value={responseAction} onChange={(e) => setResponseAction(e.target.value as typeof responseAction)}>
              <option value="revoke_sessions">Sign out all sessions</option>
              <option value="restrict_financial">Restrict financial transactions</option>
            </select>
          </div>}
          <div className="field"><label htmlFor="response-summary">Case summary</label>
            <input id="response-summary" maxLength={200} value={responseSummary} onChange={(e) => setResponseSummary(e.target.value)} />
          </div>
          <div className="field"><label htmlFor="response-notes">Reason and investigation notes</label>
            <textarea id="response-notes" maxLength={500} value={responseNotes} onChange={(e) => setResponseNotes(e.target.value)} placeholder="State the evidence checked and why this action is necessary." />
          </div>
          {responseAction === 'restrict_financial' && <p className="muted">This signs out active sessions and blocks outgoing financial authorization. It does not change the wallet balance.</p>}
          {responseAction === 'lift_restriction' && <>
            <p className="muted">Normally the customer must reset their transaction PIN using verified email before removal.</p>
            <label className="checkbox-row"><input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} /> Super-admin emergency override</label>
          </>}
          <div className="row" style={{ marginTop: 16 }}>
            <button className={responseAction === 'restrict_financial' ? 'danger' : 'primary'} disabled={busy !== null || responseSummary.trim().length < 5 || responseNotes.trim().length < 5} onClick={() => void applyResponse()}>
              {responseAction === 'restrict_financial' ? 'Apply restriction' : responseAction === 'lift_restriction' ? 'Remove restriction' : 'Sign out sessions'}
            </button>
            <button className="secondary" onClick={() => setResponseTarget(null)}>Cancel</button>
          </div>
        </div>
      </div>}
    </div>
  );
}
