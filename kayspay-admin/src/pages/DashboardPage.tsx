import { useEffect, useMemo, useState } from 'react';
import { callAdmin, AdminApiError } from '../lib/adminApi';
import { formatNaira, groupServiceVolumes } from '../lib/transactions';
import HideableStat from '../components/HideableStat';

interface Report {
  total_users: number;
  new_users_in_range: number;
  orders_in_range: number;
  orders_completed_in_range: number;
  orders_failed_in_range: number;
  orders_refunded_in_range: number;
  volume_kobo_in_range: number;
  services: { type: string; order_count: number; volume_kobo: number }[];
}

interface Integrity {
  negative_wallets: number;
  stuck_vtu: number;
  stuck_foreign_numbers: number;
  stuck_identity: number;
  duplicate_provider_refs: number;
  pending_total: number;
  unsafe_grants?: number;
}

type RangeKey = 'today' | '7d' | '30d' | 'custom';

const RANGE_LABELS: { key: RangeKey; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: '7d', label: '7 days' },
  { key: '30d', label: '30 days' },
  { key: 'custom', label: 'Custom range' },
];

function toDateInputValue(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export default function DashboardPage() {
  const [range, setRange] = useState<RangeKey>('30d');
  const [customStart, setCustomStart] = useState(toDateInputValue(new Date(Date.now() - 7 * 86400000)));
  const [customEnd, setCustomEnd] = useState(toDateInputValue(new Date()));

  const [report, setReport] = useState<Report | null>(null);
  const [integrity, setIntegrity] = useState<Integrity | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const { start, end } = useMemo(() => {
    const now = new Date();
    if (range === 'today') {
      const s = new Date(now); s.setHours(0, 0, 0, 0);
      return { start: s, end: now };
    }
    if (range === '7d') return { start: new Date(now.getTime() - 7 * 86400000), end: now };
    if (range === '30d') return { start: new Date(now.getTime() - 30 * 86400000), end: now };
    // custom: end of the selected end-date, so it includes that whole day
    const s = new Date(customStart + 'T00:00:00');
    const e = new Date(customEnd + 'T23:59:59.999');
    return { start: s, end: e };
  }, [range, customStart, customEnd]);

  useEffect(() => {
    setLoading(true);
    setError(null);
    callAdmin<{ report: Report; integrity: Integrity }>('admin-dashboard-stats', {
      query: { start: start.toISOString(), end: end.toISOString() },
    })
      .then((r) => { setReport(r.report); setIntegrity(r.integrity); })
      .catch((e) => setError(e instanceof AdminApiError ? e.message : 'Could not load stats'))
      .finally(() => setLoading(false));
  }, [start, end]);

  const services = useMemo(() => (report ? groupServiceVolumes(report.services) : []), [report]);
  const maxVolume = services[0]?.volumeKobo || 1;

  return (
    <div>
      <div className="row between" style={{ marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h2 style={{ margin: 0 }}>Dashboard</h2>
          <p className="muted" style={{ margin: '2px 0 0' }}>Overview for the period below</p>
        </div>
        <div className="range-picker">
          {RANGE_LABELS.map((r) => (
            <div
              key={r.key}
              className={`range-pill ${range === r.key ? 'active' : ''}`}
              onClick={() => setRange(r.key)}
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
            <input type="date" value={customStart} onChange={(e) => setCustomStart(e.target.value)} />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>To</label>
            <input type="date" value={customEnd} onChange={(e) => setCustomEnd(e.target.value)} />
          </div>
        </div>
      )}

      {error && <div className="error-text">{error}</div>}
      {loading && <p className="muted">Loading…</p>}

      {!loading && report && integrity && (
        <>
          <div className="stat-grid" style={{ marginBottom: 20 }}>
            <HideableStat id="totalUsers" tone="accent" value={report.total_users.toLocaleString()} label="Total users" />
            <HideableStat id="newUsers" tone="accent" value={String(report.new_users_in_range)} label="New users" />
            <HideableStat id="orders" tone="accent" value={String(report.orders_in_range)} label="Orders" />
            <HideableStat id="completedOrders" tone="accent" value={String(report.orders_completed_in_range)} label="Completed orders" />
            <HideableStat id="totalVolume" tone="dark" value={formatNaira(report.volume_kobo_in_range)} label="Total volume" />
          </div>

          <div className="card">
            <div className="row between" style={{ marginBottom: 14 }}>
              <h3 style={{ margin: 0 }}>Top services by volume</h3>
            </div>
            {services.length === 0 ? (
              <p className="muted">No completed orders in this range.</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
                {services.map((s) => (
                  <div key={s.label}>
                    <div className="row between" style={{ fontSize: 12.5, marginBottom: 4 }}>
                      <span style={{ fontWeight: 600 }}>{s.label}</span>
                      <span className="muted">{s.orderCount} orders · <strong style={{ color: 'var(--text)' }}>{formatNaira(s.volumeKobo)}</strong></span>
                    </div>
                    <div className="bar-track">
                      <div className="bar-fill" style={{ width: `${Math.max(3, (s.volumeKobo / maxVolume) * 100)}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <div className="card" style={{ marginBottom: 0 }}>
              <h3 style={{ marginTop: 0 }}>Transaction health</h3>
              <div className="row" style={{ gap: 20, flexWrap: 'wrap' }}>
                <div><div style={{ fontSize: 18, fontWeight: 800 }}>{integrity.pending_total}</div><div className="muted" style={{ fontSize: 11.5 }}>pending (all-time)</div></div>
                <div><div style={{ fontSize: 18, fontWeight: 800, color: 'var(--green-dark)' }}>{report.orders_completed_in_range}</div><div className="muted" style={{ fontSize: 11.5 }}>completed</div></div>
                <div><div style={{ fontSize: 18, fontWeight: 800, color: 'var(--error)' }}>{report.orders_failed_in_range}</div><div className="muted" style={{ fontSize: 11.5 }}>failed</div></div>
                <div><div style={{ fontSize: 18, fontWeight: 800 }}>{report.orders_refunded_in_range}</div><div className="muted" style={{ fontSize: 11.5 }}>refunded</div></div>
              </div>
            </div>

            <div className="card" style={{ marginBottom: 0, borderColor: hasAnomalies(integrity) ? 'var(--error)' : undefined }}>
              <h3 style={{ marginTop: 0 }}>Anomaly checks</h3>
              {!hasAnomalies(integrity) ? (
                <p className="muted">No anomalies detected.</p>
              ) : (
                <table>
                  <tbody>
                    {anomalyRows(integrity).map(([label, value]) => (
                      <tr key={label}><td>{label}</td><td style={{ color: 'var(--error)', fontWeight: 700 }}>{value}</td></tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function anomalyRows(integrity: Integrity): [string, number][] {
  const rows: [string, number][] = [
    ['Negative wallets', integrity.negative_wallets],
    ['Stuck VTU (>20m)', integrity.stuck_vtu],
    ['Stuck foreign numbers (>30m)', integrity.stuck_foreign_numbers],
    ['Stuck identity (>72h)', integrity.stuck_identity],
    ['Duplicate provider refs', integrity.duplicate_provider_refs],
    ['Unsafe grants', integrity.unsafe_grants ?? 0],
  ];
  return rows.filter(([, v]) => v > 0);
}

function hasAnomalies(integrity: Integrity): boolean {
  return anomalyRows(integrity).length > 0;
}
