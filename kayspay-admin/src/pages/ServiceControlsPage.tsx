import { useEffect, useMemo, useState } from 'react';
import { callAdmin, AdminApiError } from '../lib/adminApi';
import { useAuth } from '../AuthContext';

interface ServiceControl {
  service: string;
  enabled: boolean;
  reason: string | null;
  updated_at: string;
}

interface DataPlan {
  id: string;
  network: string;
  family_key: string;
  family_name: string;
  name: string;
  validity: string;
  available: boolean;
}

interface PlanControl {
  provider: string;
  network: string;
  scope_type: 'network' | 'family' | 'plan';
  scope_value: string;
  enabled: boolean;
  reason: string | null;
  source: 'manual' | 'automatic';
  updated_at: string;
}

const LABELS: Record<string, string> = {
  vtu: 'VTU (airtime, data, bills, exam pins)',
  esim: 'eSIM',
  foreign_number: 'Foreign numbers',
  identity: 'Identity (NIN/BVN Verify)',
  nin_modification: 'NIN Modification (Name/Phone/Address + Validation)',
};

const NETWORKS = ['mtn', 'glo', '9mobile', 'airtel'];

export default function ServiceControlsPage() {
  const { role } = useAuth();
  const canToggle = role === 'super_admin';
  const [services, setServices] = useState<ServiceControl[]>([]);
  const [plans, setPlans] = useState<DataPlan[]>([]);
  const [controls, setControls] = useState<PlanControl[]>([]);
  const [network, setNetwork] = useState('mtn');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pendingReason, setPendingReason] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [serviceResult, planResult] = await Promise.all([
        callAdmin<{ services: ServiceControl[] }>('admin-service-controls'),
        callAdmin<{ plans: DataPlan[]; controls: PlanControl[] }>('admin-vtu-plan-controls'),
      ]);
      setServices(serviceResult.services);
      setPlans(planResult.plans);
      setControls(planResult.controls);
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : 'Could not load availability controls');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const toggleService = async (service: string, enable: boolean) => {
    setError(null);
    const reason = enable ? '' : (pendingReason[service] || '').trim();
    if (!enable && reason.length < 3) {
      setError(`Enter a reason before disabling ${LABELS[service] || service}`);
      return;
    }
    setBusy(service);
    try {
      const result = await callAdmin<{ service: ServiceControl }>('admin-service-controls', {
        method: 'POST', body: { service, enabled: enable, reason },
      });
      setServices((current) => current.map((item) => item.service === service ? result.service : item));
      setPendingReason((current) => ({ ...current, [service]: '' }));
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : 'Could not update service');
    } finally {
      setBusy(null);
    }
  };

  const controlFor = (scopeType: PlanControl['scope_type'], scopeValue: string) =>
    controls.find((item) => item.network === network && item.scope_type === scopeType && item.scope_value === scopeValue);

  const togglePlanControl = async (
    scopeType: PlanControl['scope_type'],
    scopeValue: string,
    enable: boolean,
  ) => {
    const key = `${network}:${scopeType}:${scopeValue}`;
    const reason = enable ? '' : (pendingReason[key] || '').trim();
    if (!enable && reason.length < 3) {
      setError('Enter a reason before disabling this data option.');
      return;
    }
    setBusy(key);
    setError(null);
    try {
      const result = await callAdmin<{ control: PlanControl }>('admin-vtu-plan-controls', {
        method: 'POST',
        body: { network, scope_type: scopeType, scope_value: scopeValue, enabled: enable, reason },
      });
      setControls((current) => {
        const withoutTarget = current.filter((item) => !(
          item.network === network && item.scope_type === scopeType && item.scope_value === scopeValue
        ));
        return [...withoutTarget, result.control];
      });
      setPendingReason((current) => ({ ...current, [key]: '' }));
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : 'Could not update data availability');
    } finally {
      setBusy(null);
    }
  };

  const networkPlans = useMemo(() => plans.filter((plan) => plan.network === network), [plans, network]);
  const families = useMemo(() => Array.from(new Map(
    networkPlans.map((plan) => [plan.family_key, plan.family_name]),
  ).entries()), [networkPlans]);

  const availabilityRow = (
    label: string,
    scopeType: PlanControl['scope_type'],
    scopeValue: string,
    inheritedBlock?: string,
  ) => {
    const key = `${network}:${scopeType}:${scopeValue}`;
    const control = controlFor(scopeType, scopeValue);
    const directlyEnabled = control?.enabled !== false;
    const effectiveEnabled = directlyEnabled && !inheritedBlock;
    return (
      <tr key={key}>
        <td>{label}</td>
        <td>
          <span className={`badge ${effectiveEnabled ? 'enabled' : 'disabled'}`}>
            {effectiveEnabled ? 'Enabled' : 'Disabled'}
          </span>
        </td>
        <td className="muted">{inheritedBlock || control?.reason || '—'}</td>
        <td className="muted">{control ? `${control.source} · ${new Date(control.updated_at).toLocaleString('en-GB')}` : '—'}</td>
        {canToggle && (
          <td>
            {directlyEnabled ? (
              <div className="row" style={{ gap: 6 }}>
                <input
                  aria-label={`Reason to disable ${label}`}
                  placeholder="Reason to disable"
                  value={pendingReason[key] || ''}
                  onChange={(event) => setPendingReason((previous) => ({ ...previous, [key]: event.target.value }))}
                  style={{ width: 180 }}
                />
                <button className="danger" disabled={busy === key} onClick={() => void togglePlanControl(scopeType, scopeValue, false)}>
                  Disable
                </button>
              </div>
            ) : (
              <button className="primary" disabled={busy === key} onClick={() => void togglePlanControl(scopeType, scopeValue, true)}>
                Re-enable
              </button>
            )}
          </td>
        )}
      </tr>
    );
  };

  const networkDisabled = controlFor('network', '*')?.enabled === false;

  return (
    <div>
      <h2>Kill Switches</h2>
      {!canToggle && <p className="muted">You have view-only access. Only super admins can toggle these.</p>}
      {error && <div className="error-text">{error}</div>}

      {loading ? <p className="muted">Loading…</p> : (
        <>
          <div className="card">
            <table>
              <thead>
                <tr><th>Service</th><th>Status</th><th>Reason</th><th>Updated</th>{canToggle && <th />}</tr>
              </thead>
              <tbody>
                {services.map((service) => (
                  <tr key={service.service}>
                    <td>{LABELS[service.service] || service.service}</td>
                    <td><span className={`badge ${service.enabled ? 'enabled' : 'disabled'}`}>{service.enabled ? 'Enabled' : 'Disabled'}</span></td>
                    <td className="muted">{service.reason || '—'}</td>
                    <td className="muted">{new Date(service.updated_at).toLocaleString('en-GB')}</td>
                    {canToggle && (
                      <td>
                        {service.enabled ? (
                          <div className="row" style={{ gap: 6 }}>
                            <input
                              placeholder="Reason to disable"
                              value={pendingReason[service.service] || ''}
                              onChange={(event) => setPendingReason((previous) => ({ ...previous, [service.service]: event.target.value }))}
                              style={{ width: 180 }}
                            />
                            <button className="danger" disabled={busy === service.service} onClick={() => void toggleService(service.service, false)}>Disable</button>
                          </div>
                        ) : (
                          <button className="primary" disabled={busy === service.service} onClick={() => void toggleService(service.service, true)}>Re-enable</button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h2 style={{ marginTop: 28 }}>Data Availability</h2>
          <p className="muted">Disabled options disappear from the app and are blocked before any wallet debit.</p>
          <div className="row" style={{ marginBottom: 12 }}>
            <label htmlFor="availability-network">Network</label>
            <select id="availability-network" value={network} onChange={(event) => setNetwork(event.target.value)}>
              {NETWORKS.map((item) => <option key={item} value={item}>{item.toUpperCase()}</option>)}
            </select>
          </div>

          <div className="card">
            <h3>Network and plan families</h3>
            <table>
              <thead><tr><th>Option</th><th>Status</th><th>Reason</th><th>Updated</th>{canToggle && <th />}</tr></thead>
              <tbody>
                {availabilityRow(`All ${network.toUpperCase()} data`, 'network', '*')}
                {families.map(([familyKey, familyName]) => availabilityRow(
                  familyName,
                  'family',
                  familyKey,
                  networkDisabled ? `Blocked by the ${network.toUpperCase()} network switch` : undefined,
                ))}
              </tbody>
            </table>
          </div>

          <div className="card">
            <h3>Individual plans</h3>
            {networkPlans.length === 0 ? <p className="muted">No synced plans for this network.</p> : (
              <table>
                <thead><tr><th>Plan</th><th>Status</th><th>Reason</th><th>Updated</th>{canToggle && <th />}</tr></thead>
                <tbody>
                  {networkPlans.map((plan) => {
                    const familyDisabled = controlFor('family', plan.family_key)?.enabled === false;
                    const inheritedBlock = networkDisabled
                      ? `Blocked by the ${network.toUpperCase()} network switch`
                      : familyDisabled ? `Blocked by the ${plan.family_name} family switch` : undefined;
                    return availabilityRow(`${plan.name} · ${plan.validity}`, 'plan', plan.id, inheritedBlock);
                  })}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
}
