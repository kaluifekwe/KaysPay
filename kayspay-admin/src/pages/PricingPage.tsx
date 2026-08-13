import { useEffect, useMemo, useState } from 'react';
import { callAdmin, AdminApiError } from '../lib/adminApi';
import { useAuth } from '../AuthContext';
import { formatNaira } from '../lib/transactions';

interface DataPlan {
  id: string;
  network: string;
  family_key: string;
  family_name: string;
  name: string;
  validity: string;
  available: boolean;
  reseller_kobo: number;
}

interface PriceOverride {
  provider: string;
  network: string;
  plan_id: string;
  price_kobo: number;
  updated_at: string;
}

interface ServicePrice {
  service_key: string;
  price_kobo: number;
  updated_at: string;
}

const NETWORKS = ['mtn', 'glo', '9mobile', 'airtel'];

const SERVICE_LABELS: Record<string, string> = {
  nin_verify_regular: 'NIN Verify — Regular Slip',
  nin_verify_card: 'NIN Verify — Card',
  nin_modification: 'NIN Modification (Name/Phone/Address)',
  nin_validation: 'NIN Validation',
  bvn_verify_regular: 'BVN Verify — Regular Slip',
  bvn_verify_card: 'BVN Verify — Card',
};
const SERVICE_ORDER = Object.keys(SERVICE_LABELS);

// "1,000.00" / "1000" -> 100000 (kobo). Returns null for blank/invalid input
// so a save action can tell "clear it" apart from "not a number".
function nairaTextToKobo(text: string): number | null {
  const cleaned = text.replace(/,/g, '').trim();
  if (!cleaned) return null;
  const naira = Number(cleaned);
  if (!Number.isFinite(naira) || naira <= 0) return null;
  return Math.round(naira * 100);
}

// Same, but for a markup: 0 is a valid markup (sell at provider price with
// no addition), a negative markup is not — this is "add on top", not a
// discount tool.
function nairaTextToMarkupKobo(text: string): number | null {
  const cleaned = text.replace(/,/g, '').trim();
  if (!cleaned) return null;
  const naira = Number(cleaned);
  if (!Number.isFinite(naira) || naira < 0) return null;
  return Math.round(naira * 100);
}

export default function PricingPage() {
  const { role } = useAuth();
  const canEdit = role === 'super_admin';
  const [plans, setPlans] = useState<DataPlan[]>([]);
  const [overrides, setOverrides] = useState<PriceOverride[]>([]);
  const [servicePricing, setServicePricing] = useState<ServicePrice[]>([]);
  const [network, setNetwork] = useState('mtn');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [planInputs, setPlanInputs] = useState<Record<string, string>>({});
  const [serviceInputs, setServiceInputs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await callAdmin<{ plans: DataPlan[]; price_overrides: PriceOverride[]; service_pricing: ServicePrice[] }>(
        'admin-pricing-controls',
      );
      setPlans(result.plans);
      setOverrides(result.price_overrides);
      setServicePricing(result.service_pricing);
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : 'Could not load pricing');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const networkPlans = useMemo(() => plans.filter((plan) => plan.network === network), [plans, network]);
  const overrideFor = (planId: string) =>
    overrides.find((item) => item.network === network && item.plan_id === planId);

  const savePlanPrice = async (planId: string) => {
    const key = `plan:${network}:${planId}`;
    const text = planInputs[key];
    setError(null);
    setBusy(key);
    try {
      // Blank input clears back to the provider's own price — never
      // interpreted as "free".
      if (text === undefined || text.trim() === '') {
        await callAdmin('admin-pricing-controls', { method: 'POST', body: { target: 'plan', network, plan_id: planId, clear: true } });
        setOverrides((current) => current.filter((item) => !(item.network === network && item.plan_id === planId)));
        return;
      }
      const markupKobo = nairaTextToMarkupKobo(text);
      if (markupKobo === null) {
        setError('Enter a valid markup (0 or more), or leave it blank to use the provider price.');
        return;
      }
      const plan = networkPlans.find((item) => item.id === planId);
      if (!plan) {
        setError('Could not find this plan — try reloading the page.');
        return;
      }
      // The stored override is always the final price the customer pays —
      // this is just the provider's price plus the markup entered here.
      const priceKobo = plan.reseller_kobo + markupKobo;
      await callAdmin('admin-pricing-controls', { method: 'POST', body: { target: 'plan', network, plan_id: planId, price_kobo: priceKobo } });
      setOverrides((current) => [
        ...current.filter((item) => !(item.network === network && item.plan_id === planId)),
        { provider: 'vtunaija', network, plan_id: planId, price_kobo: priceKobo, updated_at: new Date().toISOString() },
      ]);
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : 'Could not save the price');
    } finally {
      setBusy(null);
    }
  };

  const saveServicePrice = async (serviceKey: string) => {
    setError(null);
    const priceKobo = nairaTextToKobo(serviceInputs[serviceKey] ?? '');
    if (priceKobo === null) {
      setError('Enter a valid amount.');
      return;
    }
    setBusy(`service:${serviceKey}`);
    try {
      await callAdmin('admin-pricing-controls', { method: 'POST', body: { target: 'service', service_key: serviceKey, price_kobo: priceKobo } });
      setServicePricing((current) => [
        ...current.filter((item) => item.service_key !== serviceKey),
        { service_key: serviceKey, price_kobo: priceKobo, updated_at: new Date().toISOString() },
      ]);
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : 'Could not save the price');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <h2>Pricing</h2>
      <p className="muted">
        Data plans: enter a markup to add on top of the provider's price — leave it blank to charge the provider's price with no markup. NIN &amp; BVN services: enter the full price customers pay. Changes apply to the very next purchase.
      </p>
      {!canEdit && <p className="muted">You have view-only access. Only super admins can change prices.</p>}
      {error && <div className="error-text">{error}</div>}

      {loading ? <p className="muted">Loading…</p> : (
        <>
          <div className="card">
            <h3>Data Plan Pricing</h3>
            <p className="muted">Showing available and unavailable plans — pricing works independently of availability, set on the Service Controls page.</p>
            <div className="row" style={{ marginBottom: 12 }}>
              <label htmlFor="pricing-network">Network</label>
              <select id="pricing-network" value={network} onChange={(event) => setNetwork(event.target.value)}>
                {NETWORKS.map((item) => <option key={item} value={item}>{item.toUpperCase()}</option>)}
              </select>
            </div>
            {networkPlans.length === 0 ? <p className="muted">No synced plans for this network.</p> : (
              <table>
                <thead>
                  <tr><th>Plan</th><th>Status</th><th>Provider Price</th><th>Your Markup</th><th>Customer Pays</th>{canEdit && <th />}</tr>
                </thead>
                <tbody>
                  {networkPlans.map((plan) => {
                    const key = `plan:${network}:${plan.id}`;
                    const override = overrideFor(plan.id);
                    const inputValue = planInputs[key] ?? (override ? ((override.price_kobo - plan.reseller_kobo) / 100).toFixed(2) : '');
                    const draftText = planInputs[key];
                    const previewMarkupKobo = draftText === undefined
                      ? (override ? override.price_kobo - plan.reseller_kobo : 0)
                      : (draftText.trim() === '' ? 0 : nairaTextToMarkupKobo(draftText));
                    const customerPaysKobo = previewMarkupKobo === null ? null : plan.reseller_kobo + previewMarkupKobo;
                    return (
                      <tr key={plan.id}>
                        <td>{plan.name} · {plan.validity}</td>
                        <td><span className={`badge ${plan.available ? 'enabled' : 'disabled'}`}>{plan.available ? 'Available' : 'Unavailable'}</span></td>
                        <td className="mono muted">{formatNaira(plan.reseller_kobo)}</td>
                        <td>
                          <input
                            className="mono"
                            style={{ width: 110, textAlign: 'right', borderColor: override ? 'var(--warning)' : undefined, background: override ? '#fffbeb' : undefined }}
                            placeholder="0"
                            value={inputValue}
                            disabled={!canEdit}
                            onChange={(event) => setPlanInputs((current) => ({ ...current, [key]: event.target.value }))}
                          />
                        </td>
                        <td className="mono">{customerPaysKobo === null ? '—' : formatNaira(customerPaysKobo)}</td>
                        {canEdit && (
                          <td>
                            <button className="primary" style={{ padding: '6px 12px', fontSize: 12 }} disabled={busy === key} onClick={() => void savePlanPrice(plan.id)}>
                              Save
                            </button>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          <div className="card">
            <h3>NIN &amp; BVN Service Pricing</h3>
            <table>
              <thead><tr><th>Service</th><th>Your Price</th>{canEdit && <th />}</tr></thead>
              <tbody>
                {SERVICE_ORDER.map((serviceKey) => {
                  const row = servicePricing.find((item) => item.service_key === serviceKey);
                  const inputValue = serviceInputs[serviceKey] ?? (row ? (row.price_kobo / 100).toFixed(2) : '');
                  return (
                    <tr key={serviceKey}>
                      <td>{SERVICE_LABELS[serviceKey]}</td>
                      <td>
                        <input
                          className="mono"
                          style={{ width: 110, textAlign: 'right' }}
                          value={inputValue}
                          disabled={!canEdit}
                          onChange={(event) => setServiceInputs((current) => ({ ...current, [serviceKey]: event.target.value }))}
                        />
                      </td>
                      {canEdit && (
                        <td>
                          <button className="primary" style={{ padding: '6px 12px', fontSize: 12 }} disabled={busy === `service:${serviceKey}`} onClick={() => void saveServicePrice(serviceKey)}>
                            Save
                          </button>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
