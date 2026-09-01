import { useCallback, useEffect, useState } from 'react';
import { AdminApiError, callAdmin } from '../lib/adminApi';

interface StuckSell {
  transaction_id: string;
  user_id: string;
  crypto_micro: number;
  asset: string;
  quidax_reference: string | null;
  quidax_merchant_reference: string | null;
  failure_reason: string | null;
  created_at: string;
  alert_status: string | null;
}

type Resolution = 'ngn_paid_by_quidax' | 'crypto_returned' | 'writeoff';

const RESOLUTION_LABEL: Record<Resolution, string> = {
  ngn_paid_by_quidax: 'Quidax paid the bank directly',
  crypto_returned: 'Quidax returned the USDT to the sub-account',
  writeoff: 'Confirmed unrecoverable — write off',
};

function formatUsdt(micro: number): string {
  return (micro / 1_000_000).toLocaleString('en-US', { maximumFractionDigits: 6 });
}

export default function CryptoRecoveryPage() {
  const [items, setItems] = useState<StuckSell[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [resolution, setResolution] = useState<Resolution>('ngn_paid_by_quidax');
  const [notes, setNotes] = useState('');
  const [settledNaira, setSettledNaira] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await callAdmin<{ stuck_sells: StuckSell[] }>('admin-crypto-sell-resolve');
      setItems(response.stuck_sells);
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : 'Could not load stuck sells.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const openResolve = (id: string) => {
    setActiveId(id);
    setResolution('ngn_paid_by_quidax');
    setNotes('');
    setSettledNaira('');
    setFormError(null);
  };

  const submitResolve = async () => {
    if (!activeId) return;
    if (notes.trim().length < 3) {
      setFormError('Add a short note on what Quidax confirmed.');
      return;
    }
    let settledNgnKobo: number | undefined;
    if (resolution === 'ngn_paid_by_quidax') {
      const naira = Number(settledNaira);
      if (!Number.isFinite(naira) || naira <= 0) {
        setFormError('Enter the confirmed amount Quidax paid, in Naira.');
        return;
      }
      settledNgnKobo = Math.round(naira * 100);
    }
    setSubmitting(true);
    setFormError(null);
    try {
      await callAdmin('admin-crypto-sell-resolve', {
        method: 'POST',
        body: { transaction_id: activeId, resolution, notes: notes.trim(), settled_ngn_kobo: settledNgnKobo },
      });
      setActiveId(null);
      await load();
    } catch (e) {
      setFormError(e instanceof AdminApiError ? e.message : 'Could not resolve this transaction.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <h2 style={{ margin: '0 0 4px' }}>Crypto sell recovery</h2>
      <p className="muted" style={{ marginBottom: 20 }}>
        Sells stuck in a failed off-ramp payout — the customer's crypto already left their Quidax sub-account
        before the bank payout failed, so nothing can be reversed automatically. Confirm the real outcome with
        Quidax directly before resolving one of these.
      </p>

      {loading && <p className="muted">Loading…</p>}
      {error && <p className="error-text">{error}</p>}

      {!loading && !error && items.length === 0 && (
        <div className="card"><p className="muted">Nothing stuck right now.</p></div>
      )}

      {items.map((item) => (
        <div className="card" key={item.transaction_id}>
          <div className="row between" style={{ marginBottom: 10 }}>
            <strong>{formatUsdt(item.crypto_micro)} {item.asset}</strong>
            <span className={`badge ${item.alert_status === 'resolved' ? 'resolved' : 'critical'}`}>
              {item.alert_status === 'resolved' ? 'alert resolved' : 'alert open'}
            </span>
          </div>
          <p className="mono muted" style={{ fontSize: 11, margin: '4px 0' }}>
            {item.quidax_reference || '—'} · {item.quidax_merchant_reference || '—'}
          </p>
          <p className="muted" style={{ fontSize: 12, margin: '4px 0 12px' }}>
            {item.failure_reason || 'offramp_failed'} · {new Date(item.created_at).toLocaleString()}
          </p>
          {activeId === item.transaction_id ? (
            <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
              <div className="field">
                <label>What did Quidax confirm?</label>
                <select value={resolution} onChange={(e) => setResolution(e.target.value as Resolution)}>
                  {(Object.keys(RESOLUTION_LABEL) as Resolution[]).map((r) => (
                    <option key={r} value={r}>{RESOLUTION_LABEL[r]}</option>
                  ))}
                </select>
              </div>
              {resolution === 'ngn_paid_by_quidax' && (
                <div className="field">
                  <label>Confirmed amount paid (₦)</label>
                  <input value={settledNaira} onChange={(e) => setSettledNaira(e.target.value)} placeholder="e.g. 6307.08" />
                </div>
              )}
              <div className="field">
                <label>Notes (what Quidax told you, ticket ref, etc.)</label>
                <textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
              </div>
              {formError && <p className="error-text">{formError}</p>}
              <div className="row" style={{ gap: 8 }}>
                <button className="primary" onClick={() => void submitResolve()} disabled={submitting}>
                  {submitting ? 'Resolving…' : 'Confirm resolution'}
                </button>
                <button className="secondary" onClick={() => setActiveId(null)} disabled={submitting}>Cancel</button>
              </div>
            </div>
          ) : (
            <button className="secondary" onClick={() => openResolve(item.transaction_id)}>Resolve</button>
          )}
        </div>
      ))}
    </div>
  );
}
