import { useCallback, useEffect, useState } from 'react';
import { callAdmin, AdminApiError } from '../lib/adminApi';
import { formatNaira } from '../lib/transactions';

interface PromoCode {
  id: string;
  code: string;
  creator_name: string;
  active: boolean;
  created_at: string;
  registered: number;
  kyc_verified: number;
  funded: number;
  purchased: number;
  total_funded_kobo: number;
  total_purchase_volume_kobo: number;
}

export default function CreatorsPage() {
  const [codes, setCodes] = useState<PromoCode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newCode, setNewCode] = useState('');
  const [newCreatorName, setNewCreatorName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const response = await callAdmin<{ promo_codes: PromoCode[] }>('admin-campaigns', { query: { resource: 'promo_codes' } });
      setCodes(response.promo_codes);
    } catch (loadError) {
      setError(loadError instanceof AdminApiError ? loadError.message : 'Could not load creator codes');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const createCode = async () => {
    setCreateError(null);
    if (!newCode.trim() || !newCreatorName.trim()) { setCreateError('Enter both a code and the creator\'s name'); return; }
    setCreating(true);
    try {
      await callAdmin('admin-campaigns', { method: 'POST', body: { action: 'create_promo_code', code: newCode.trim(), creator_name: newCreatorName.trim() } });
      setNewCode(''); setNewCreatorName('');
      await load();
    } catch (createErr) {
      setCreateError(createErr instanceof AdminApiError ? createErr.message : 'Could not create the code');
    } finally { setCreating(false); }
  };

  const toggleActive = async (code: PromoCode) => {
    setTogglingId(code.id); setError(null);
    try {
      await callAdmin('admin-campaigns', { method: 'POST', body: { action: 'toggle_promo_code', id: code.id, active: !code.active } });
      await load();
    } catch (toggleErr) {
      setError(toggleErr instanceof AdminApiError ? toggleErr.message : 'Could not update the code');
    } finally { setTogglingId(null); }
  };

  return <div>
    <div className="row between" style={{ marginBottom: 16 }}>
      <div><h2 style={{ margin: 0 }}>Creators</h2><p className="muted" style={{ margin: '2px 0 0' }}>Give each content creator their own promo code to track exactly who they bring in, and how far those users get.</p></div>
    </div>

    <div className="card" style={{ marginBottom: 20 }}>
      <h3 style={{ marginTop: 0 }}>New creator code</h3>
      <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div className="field" style={{ marginBottom: 0, width: 200 }}>
          <label>Code</label>
          <input placeholder="e.g. JOHN10" value={newCode} onChange={(e) => setNewCode(e.target.value.toUpperCase())} disabled={creating} />
        </div>
        <div className="field" style={{ marginBottom: 0, width: 240 }}>
          <label>Creator name</label>
          <input placeholder="e.g. John Adeyemi" value={newCreatorName} onChange={(e) => setNewCreatorName(e.target.value)} disabled={creating} />
        </div>
        <button className="primary" onClick={() => void createCode()} disabled={creating}>{creating ? 'Creating…' : 'Create code'}</button>
      </div>
      {createError && <div className="error-text" style={{ marginTop: 8 }}>{createError}</div>}
    </div>

    {error && <div className="error-text" style={{ marginBottom: 16 }}>{error}</div>}

    <div className="card table-scroll">
      {loading ? (
        <p className="muted">Loading…</p>
      ) : codes.length === 0 ? (
        <p className="muted">No creator codes yet — create one above.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Code</th><th>Creator</th><th>Status</th>
              <th>Registered</th><th>KYC verified</th><th>Funded</th><th>Made a purchase</th>
              <th>Total funded</th><th>Total purchase volume</th><th></th>
            </tr>
          </thead>
          <tbody>
            {codes.map((c) => (
              <tr key={c.id}>
                <td className="mono">{c.code}</td>
                <td>{c.creator_name}</td>
                <td><span className={`badge ${c.active ? 'completed' : 'pending'}`}>{c.active ? 'Active' : 'Inactive'}</span></td>
                <td>{c.registered.toLocaleString()}</td>
                <td>{c.kyc_verified.toLocaleString()}</td>
                <td>{c.funded.toLocaleString()}</td>
                <td>{c.purchased.toLocaleString()}</td>
                <td>{formatNaira(c.total_funded_kobo)}</td>
                <td>{formatNaira(c.total_purchase_volume_kobo)}</td>
                <td>
                  <button className="secondary" disabled={togglingId === c.id} onClick={() => void toggleActive(c)}>
                    {togglingId === c.id ? 'Saving…' : c.active ? 'Deactivate' : 'Activate'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  </div>;
}
