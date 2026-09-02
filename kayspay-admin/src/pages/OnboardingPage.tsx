import { useCallback, useEffect, useMemo, useState } from 'react';
import { AdminApiError, callAdmin } from '../lib/adminApi';

interface FunnelStage { key: string; count: number; }
type FaultCategory = 'app_error' | 'provider_rejected' | 'provider_unavailable' | 'customer_input' | 'unknown' | 'unclassified';
interface FailureRow { event_type: string; failure_code: string | null; affected_installations: number; attempts: number; fault_category: FaultCategory; }
interface BreakdownRow { value: string; installations: number; }
type LifecycleStage = 'pin_not_set' | 'kyc_completed_not_funded' | 'funded_not_purchased';
interface LifecycleSentStats { sent: number; opened: number; clicked: number; failed: number; resolved: number; }
interface LifecycleReminderReport {
  enabled: boolean;
  stuck_now: Record<LifecycleStage, number>;
  sent_stats: Partial<Record<LifecycleStage, LifecycleSentStats>>;
}
interface OnboardingReport {
  cohort: { start: string; end: string; installations: number };
  conversion: Record<string, number | null>;
  stages: FunnelStage[];
  timing: Record<string, number | null>;
  stuck: Record<string, number>;
  failures: FailureRow[];
  breakdowns: Record<'platform' | 'app_version' | 'country' | 'network', BreakdownRow[]>;
  lifecycle_reminders: LifecycleReminderReport | null;
}

interface Filters {
  start: string; end: string; platform: string; appVersion: string;
  country: string; network: string; source: string;
}

const STAGE_LABELS: Record<string, string> = {
  app_opened: 'App opened', onboarding_started: 'Onboarding started',
  registration_started: 'Registration started', account_created: 'Account created',
  email_verified: 'Email verified', pin_setup: 'PIN set', home_viewed: 'Reached home',
  kyc_started: 'KYC started', kyc_completed: 'KYC completed',
  funding_started: 'Funding started', first_funding: 'First funding', first_purchase: 'First purchase',
};
const STUCK_LABELS: Record<string, string> = {
  registered_not_verified: 'Registered, email not verified',
  verified_pin_incomplete: 'Verified, PIN incomplete',
  home_kyc_not_started: 'Reached home, KYC not started',
  kyc_not_completed: 'KYC started, not completed',
  kyc_completed_not_funded: 'KYC completed, not funded',
  funding_started_not_completed: 'Funding started, not completed',
  funded_not_purchased: 'Funded, no first purchase',
};
const LIFECYCLE_STAGE_LABELS: Record<LifecycleStage, string> = {
  pin_not_set: 'Verified, PIN not set',
  kyc_completed_not_funded: 'KYC verified, wallet not funded',
  funded_not_purchased: 'Funded, no purchase yet',
};
const TIMING_LABELS: Record<string, string> = {
  activation_to_account: 'App open → account', account_to_verification: 'Account → verification',
  verification_to_home: 'Verification → home', kyc_to_funding: 'KYC → funding',
  funding_to_purchase: 'Funding → purchase',
};

function dateValue(date: Date): string { return date.toISOString().slice(0, 10); }
function initialFilters(): Filters {
  const now = new Date();
  return {
    start: dateValue(new Date(now.getTime() - 30 * 86400000)), end: dateValue(now),
    platform: '', appVersion: '', country: '', network: '', source: '',
  };
}
function startIso(value: string): string { return new Date(`${value}T00:00:00`).toISOString(); }
function endIso(value: string): string { return new Date(`${value}T23:59:59.999`).toISOString(); }
function percent(value: number | null | undefined): string { return value == null ? '—' : `${value.toFixed(1)}%`; }
function duration(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  if (value < 60) return `${Math.round(value)} sec`;
  if (value < 3600) return `${Math.round(value / 60)} min`;
  if (value < 86400) return `${(value / 3600).toFixed(value < 7200 ? 1 : 0)} hr`;
  return `${(value / 86400).toFixed(1)} days`;
}
function humanize(value: string): string {
  return value.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

// Who's actually responsible for a failure, at a glance — see migration
// 190's CASE mapping for exactly which failure_code lands in which bucket.
const FAULT_LABELS: Record<FaultCategory, string> = {
  app_error: 'App bug', provider_rejected: 'Provider declined', provider_unavailable: 'Provider unavailable',
  customer_input: 'Customer input', unknown: 'Unclear cause', unclassified: 'Unclassified',
};
const FAULT_BADGE_CLASS: Record<FaultCategory, string> = {
  app_error: 'failed', provider_rejected: 'warning', provider_unavailable: 'pending',
  customer_input: 'refunded', unknown: 'refunded', unclassified: 'refunded',
};

export default function OnboardingPage() {
  const [filters, setFilters] = useState<Filters>(initialFilters);
  const [report, setReport] = useState<OnboardingReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [togglingReminders, setTogglingReminders] = useState(false);

  const load = useCallback(async (requested: Filters) => {
    if (!requested.start || !requested.end || requested.start > requested.end) {
      setError('Choose a valid date range.'); return;
    }
    if (requested.country && !/^[A-Za-z]{2}$/.test(requested.country)) {
      setError('Country must be a two-letter code, for example NG.'); return;
    }
    setLoading(true); setError(null);
    try {
      const response = await callAdmin<{ report: OnboardingReport }>('admin-onboarding-report', { query: {
        start: startIso(requested.start), end: endIso(requested.end), platform: requested.platform,
        app_version: requested.appVersion.trim(), country: requested.country.toUpperCase(),
        network: requested.network, source: requested.source.trim(),
      } });
      setReport(response.report);
    } catch (loadError) {
      setError(loadError instanceof AdminApiError ? loadError.message : 'Could not load onboarding intelligence.');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(filters); }, []);

  const toggleLifecycleReminders = useCallback(async (nextEnabled: boolean) => {
    setTogglingReminders(true); setError(null);
    try {
      await callAdmin('admin-app-settings', {
        method: 'POST',
        body: { key: 'lifecycle_reminders_enabled', value: nextEnabled ? 'true' : 'false' },
      });
      await load(filters);
    } catch (toggleError) {
      setError(toggleError instanceof AdminApiError ? toggleError.message : 'Could not update lifecycle reminders.');
    } finally { setTogglingReminders(false); }
  }, [filters, load]);

  const stageRows = useMemo(() => {
    if (!report) return [];
    const first = report.stages[0]?.count || 0;
    return report.stages.map((stage, index) => {
      const previous = index > 0 ? report.stages[index - 1].count : stage.count;
      return {
        ...stage,
        stepConversion: index === 0 ? null : previous > 0 ? stage.count / previous * 100 : null,
        overallConversion: first > 0 ? stage.count / first * 100 : null,
        dropoff: index === 0 ? 0 : Math.max(previous - stage.count, 0),
      };
    });
  }, [report]);

  const stage = (key: string) => report?.stages.find((item) => item.key === key)?.count || 0;
  const hasData = !!report && report.cohort.installations > 0;

  // Installations affected, summed per fault category — the at-a-glance
  // "is this on us or on the provider" answer, before drilling into rows.
  const faultTotals = useMemo(() => {
    const totals: Record<FaultCategory, number> = {
      app_error: 0, provider_rejected: 0, provider_unavailable: 0, customer_input: 0, unknown: 0, unclassified: 0,
    };
    for (const row of report?.failures || []) totals[row.fault_category] += row.affected_installations;
    return totals;
  }, [report]);

  return <div>
    <div className="row between onboarding-header">
      <div><h2>Onboarding Intelligence</h2><p className="muted">Conversion, abandonment, failures, and time-to-value for new app installations.</p></div>
      <button className="secondary" onClick={() => void load(filters)} disabled={loading}>Refresh</button>
    </div>

    <div className="card onboarding-filters">
      <label>From<input type="date" value={filters.start} onChange={(event) => setFilters({ ...filters, start: event.target.value })} /></label>
      <label>To<input type="date" value={filters.end} onChange={(event) => setFilters({ ...filters, end: event.target.value })} /></label>
      <label>Platform<select value={filters.platform} onChange={(event) => setFilters({ ...filters, platform: event.target.value })}>
        <option value="">All platforms</option><option value="android">Android</option><option value="ios">iOS</option><option value="web">Web</option><option value="unknown">Unknown</option>
      </select></label>
      <label>App version<input placeholder="e.g. 1.0.1" value={filters.appVersion} onChange={(event) => setFilters({ ...filters, appVersion: event.target.value })} /></label>
      <label>Country<input placeholder="NG" maxLength={2} value={filters.country} onChange={(event) => setFilters({ ...filters, country: event.target.value.toUpperCase() })} /></label>
      <label>Network<select value={filters.network} onChange={(event) => setFilters({ ...filters, network: event.target.value })}>
        <option value="">All networks</option><option value="wifi">Wi-Fi</option><option value="cellular">Cellular</option><option value="offline">Offline</option><option value="unknown">Unknown</option>
      </select></label>
      <label>Acquisition source<input placeholder="Optional source" value={filters.source} onChange={(event) => setFilters({ ...filters, source: event.target.value })} /></label>
      <div className="row onboarding-filter-actions"><button className="primary" onClick={() => void load(filters)} disabled={loading}>Apply</button><button className="secondary" onClick={() => { const reset = initialFilters(); setFilters(reset); void load(reset); }} disabled={loading}>Reset</button></div>
    </div>

    {error && <div className="error-text" style={{ marginBottom: 16 }}>{error}</div>}
    {loading && <div className="card"><p className="muted">Loading onboarding intelligence…</p></div>}
    {!loading && report && !hasData && <div className="card onboarding-empty"><h3>No analytics in this cohort yet</h3><p className="muted">Version-code 21 must reach customers before the mobile app begins sending onboarding events. Try a later date range after rollout.</p></div>}

    {!loading && report && hasData && <>
      <div className="stat-grid onboarding-summary">
        <div className="stat accent"><div className="value">{report.cohort.installations.toLocaleString()}</div><div className="label">App activations</div></div>
        <div className="stat accent"><div className="value">{stage('account_created').toLocaleString()}</div><div className="label">Accounts created</div></div>
        <div className="stat accent"><div className="value">{stage('first_funding').toLocaleString()}</div><div className="label">First fundings</div></div>
        <div className="stat accent"><div className="value">{stage('first_purchase').toLocaleString()}</div><div className="label">First purchases</div></div>
        <div className="stat dark"><div className="value">{percent(report.conversion.overall_activation_percent)}</div><div className="label">Activation rate</div></div>
      </div>

      <div className="card">
        <div className="row between section-heading"><div><h3>Onboarding funnel</h3><p className="muted">One count per installation. Drop-off compares each step with the previous step.</p></div></div>
        <div className="funnel-list">
          {stageRows.map((item) => <div className="funnel-row" key={item.key}>
            <div className="funnel-stage"><strong>{STAGE_LABELS[item.key] || humanize(item.key)}</strong><span>{item.count.toLocaleString()} installations</span></div>
            <div className="funnel-visual"><div className="funnel-track"><div className="funnel-fill" style={{ width: `${Math.max(item.overallConversion || 0, item.count ? 2 : 0)}%` }} /></div></div>
            <div className="funnel-metric"><strong>{percent(item.overallConversion)}</strong><span>overall</span></div>
            <div className="funnel-metric"><strong>{item.stepConversion == null ? '—' : percent(item.stepConversion)}</strong><span>from prior</span></div>
            <div className={`funnel-dropoff ${item.dropoff > 0 ? 'has-dropoff' : ''}`}><strong>{item.dropoff.toLocaleString()}</strong><span>dropped</span></div>
          </div>)}
        </div>
      </div>

      <div className="onboarding-two-column">
        <div className="card"><h3>Time between milestones</h3><div className="timing-list">
          {Object.entries(TIMING_LABELS).map(([key, label]) => <div className="timing-row" key={key}><span>{label}</span><span><strong>{duration(report.timing[`${key}_median_seconds`])}</strong><small>P75 {duration(report.timing[`${key}_p75_seconds`])}</small></span></div>)}
        </div></div>
        <div className="card"><h3>Customers currently stuck</h3><div className="stuck-list">
          {Object.entries(STUCK_LABELS).map(([key, label]) => <div className="stuck-row" key={key}><span>{label}</span><strong className={(report.stuck[key] || 0) > 0 ? 'warning-number' : ''}>{(report.stuck[key] || 0).toLocaleString()}</strong></div>)}
        </div><p className="muted stuck-note">These are analytical counts, not marketing eligibility. Consent checks will be added in the campaign phase.</p></div>
      </div>

      {report.lifecycle_reminders && <div className="card">
        <div className="row between section-heading">
          <div><h3>Lifecycle reminders</h3><p className="muted">Automated emails for customers stuck at PIN setup, funding, or first purchase. Up to 2 attempts per stage, then it stops for good.</p></div>
          <button
            className={report.lifecycle_reminders.enabled ? 'secondary' : 'primary'}
            disabled={togglingReminders}
            onClick={() => void toggleLifecycleReminders(!report.lifecycle_reminders!.enabled)}
          >
            {togglingReminders ? 'Saving…' : report.lifecycle_reminders.enabled ? 'Pause reminders' : 'Enable reminders'}
          </button>
        </div>
        <table><thead><tr><th>Stage</th><th>Stuck right now</th><th>Sent</th><th>Opened</th><th>Clicked</th><th>Resolved after send</th></tr></thead><tbody>
          {(Object.keys(LIFECYCLE_STAGE_LABELS) as LifecycleStage[]).map((stage) => {
            const stats = report.lifecycle_reminders!.sent_stats[stage];
            return <tr key={stage}>
              <td>{LIFECYCLE_STAGE_LABELS[stage]}</td>
              <td><strong className={report.lifecycle_reminders!.stuck_now[stage] > 0 ? 'warning-number' : ''}>{(report.lifecycle_reminders!.stuck_now[stage] || 0).toLocaleString()}</strong></td>
              <td>{(stats?.sent || 0).toLocaleString()}</td>
              <td>{(stats?.opened || 0).toLocaleString()}</td>
              <td>{(stats?.clicked || 0).toLocaleString()}</td>
              <td>{(stats?.resolved || 0).toLocaleString()}</td>
            </tr>;
          })}
        </tbody></table>
        {!report.lifecycle_reminders.enabled && <p className="muted" style={{ marginTop: 12 }}>Paused — no reminders are being sent. Enable to start sending to customers currently stuck.</p>}
      </div>}

      <div className="card table-scroll"><h3>Top failure reasons</h3>
        {report.failures.length === 0 ? <p className="muted">No failed onboarding events in this cohort.</p> : <>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
          {(Object.keys(FAULT_LABELS) as FaultCategory[]).filter((cat) => faultTotals[cat] > 0).map((cat) => (
            <span key={cat} className={`badge ${FAULT_BADGE_CLASS[cat]}`}>{FAULT_LABELS[cat]}: {faultTotals[cat].toLocaleString()}</span>
          ))}
        </div>
        <table><thead><tr><th>Journey area</th><th>Failure code</th><th>Whose fault</th><th>Affected installations</th><th>Attempts</th></tr></thead><tbody>
          {report.failures.map((failure, index) => <tr key={`${failure.event_type}:${failure.failure_code}:${index}`}><td>{humanize(failure.event_type)}</td><td><span className="badge failed">{failure.failure_code ? humanize(failure.failure_code) : 'Unknown'}</span></td><td><span className={`badge ${FAULT_BADGE_CLASS[failure.fault_category]}`}>{FAULT_LABELS[failure.fault_category]}</span></td><td>{failure.affected_installations.toLocaleString()}</td><td>{failure.attempts.toLocaleString()}</td></tr>)}
        </tbody></table>
        </>}
      </div>

      <div className="breakdown-grid">
        {(['platform', 'app_version', 'country', 'network'] as const).map((dimension) => <div className="card" key={dimension}><h3>{humanize(dimension)}</h3>
          {report.breakdowns[dimension].length === 0 ? <p className="muted">No values.</p> : <div className="breakdown-list">{report.breakdowns[dimension].slice(0, 8).map((row) => <div className="breakdown-row" key={row.value}><span>{row.value}</span><strong>{row.installations.toLocaleString()}</strong></div>)}</div>}
        </div>)}
      </div>
    </>}
  </div>;
}

