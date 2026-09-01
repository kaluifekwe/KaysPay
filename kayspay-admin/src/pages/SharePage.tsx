import { useCallback, useEffect, useState } from 'react';
import { AdminApiError, callAdmin } from '../lib/adminApi';

interface RecentItem { type: string; amount_kobo: number; occurred_at: string; }
interface ShareReport {
  total_users: number;
  completed_transactions: number;
  total_volume_kobo: number;
  recent: RecentItem[];
}

// Deliberately separate from TransactionsPage's raw type strings — this
// page is the one meant to be screenshotted and posted publicly, so every
// label here is written for an outside audience, not an admin who already
// knows what "wallet_fund" means.
const TYPE_LABELS: Record<string, string> = {
  wallet_fund: 'Wallet funded',
  airtime: 'Airtime top-up',
  data: 'Data purchase',
  bill: 'Bill payment',
  crypto_buy: 'Crypto purchase',
  crypto_sell: 'Crypto sale',
  esim: 'Travel eSIM',
  nin_bvn: 'Identity verification',
  exam_pin: 'Exam PIN purchase',
  transfer: 'Wallet transfer',
};
const TYPE_ICON: Record<string, string> = {
  wallet_fund: '💳',
  airtime: '📱',
  data: '📶',
  bill: '🧾',
  crypto_buy: '🪙',
  crypto_sell: '🪙',
  esim: '🌍',
  nin_bvn: '🪪',
  exam_pin: '🎓',
  transfer: '↔️',
};

function humanizeType(type: string): string {
  return TYPE_LABELS[type] || type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatNaira(kobo: number): string {
  return `₦${(kobo / 100).toLocaleString('en-NG', { maximumFractionDigits: 0 })}`;
}

function formatDate(date: Date): string {
  return date.toLocaleDateString('en-NG', { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function SharePage() {
  const [report, setReport] = useState<ShareReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await callAdmin<{ report: ShareReport }>('admin-share-report');
      setReport(response.report);
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : 'Could not load share stats.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <div>
      <h2 style={{ margin: '0 0 4px' }}>Share</h2>
      <p className="muted" style={{ marginBottom: 20 }}>Branded, screenshot-ready views for social media — no customer names, phone numbers, or recipients anywhere on this page.</p>

      {loading && <p className="muted">Loading…</p>}
      {error && <p className="error-text">{error}</p>}

      {report && (
        <div className="share-grid">
          <div className="share-card">
            <div className="share-card-brand">
              <div className="share-card-logo">🅺</div>
              <span>KaysPay</span>
            </div>
            <p className="share-card-eyebrow">OUR NUMBERS SO FAR</p>
            <p className="share-card-headline">Powering everyday payments across Nigeria</p>
            <div className="share-card-stats">
              <div className="share-card-stat">
                <p className="share-card-stat-value">{formatNaira(report.total_volume_kobo)}</p>
                <p className="share-card-stat-label">Volume processed</p>
              </div>
              <div className="share-card-stat">
                <p className="share-card-stat-value">{report.completed_transactions.toLocaleString()}</p>
                <p className="share-card-stat-label">Transactions completed</p>
              </div>
            </div>
            <div className="share-card-stat share-card-stat-wide">
              <p className="share-card-stat-value">{report.total_users.toLocaleString()}</p>
              <p className="share-card-stat-label">Customers trusting KaysPay</p>
            </div>
            <div className="share-card-footer">
              <span>kayspay.com.ng</span>
              <span>As of {formatDate(new Date())}</span>
            </div>
          </div>

          <div className="share-feed">
            <div className="share-feed-brand">
              <div className="share-feed-logo">🅺</div>
              <span>KaysPay</span>
            </div>
            <p className="share-feed-headline">Live on the platform right now</p>
            <div className="share-feed-list">
              {report.recent.map((item, i) => (
                <div className="share-feed-row" key={i}>
                  <div className="share-feed-icon">{TYPE_ICON[item.type] || '💰'}</div>
                  <span className="share-feed-type">{humanizeType(item.type)}</span>
                  <span className="share-feed-amount">{formatNaira(item.amount_kobo)}</span>
                </div>
              ))}
              {report.recent.length === 0 && <p className="muted">No completed transactions yet.</p>}
            </div>
            <div className="share-feed-footer">kayspay.com.ng · updated live</div>
          </div>
        </div>
      )}
    </div>
  );
}
