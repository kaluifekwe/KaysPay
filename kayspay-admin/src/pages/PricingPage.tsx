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
  computed_markup_kobo: number | null;
  computed_list_price_kobo: number | null;
  computed_discount_kobo: number | null;
  computed_cashback_kobo: number | null;
  computed_price_kobo: number | null;
}

interface MarkupBracket {
  id: number;
  min_price_kobo: number;
  max_price_kobo: number;
  markup_type: 'flat' | 'percent';
  markup_value: number;
  updated_at: string;
}

interface PricingEngineConfig {
  enabled: boolean;
  value_density_enabled: boolean;
  value_density_max_adjust_percent: number;
  value_density_price_window_percent: number;
  min_markup_floor_kobo: number;
  discount_percent_of_markup: number;
  cashback_percent_of_markup: number;
  updated_at: string;
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
  provider_cost_kobo: number;
  updated_at: string;
}

interface CableTVPlan {
  id: string;
  provider: string;
  cabletv_plan_id: string;
  name: string;
  validity: string;
  available: boolean;
  reseller_kobo: number;
}

interface CableTVOverride {
  provider: string;
  plan_id: string;
  price_kobo: number;
  updated_at: string;
}

interface ExamPlan {
  id: string;
  name: string;
  customer_kobo: number;
  available: boolean;
  requires_review: boolean;
}

interface ExamOverride {
  exam_id: string;
  price_kobo: number;
  updated_at: string;
}

interface ElectricityFee {
  fee_kobo: number;
  updated_at: string;
}

const NETWORKS = ['mtn', 'glo', '9mobile', 'airtel'];
const CABLETV_PROVIDERS = ['gotv', 'dstv', 'startimes'];

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
// or a negative value — 0 is valid (no markup/fee added), but this is
// "add on top", not a discount tool, so negatives aren't accepted.
function nairaTextToMarkupKobo(text: string): number | null {
  const cleaned = text.replace(/,/g, '').trim();
  if (!cleaned) return null;
  const naira = Number(cleaned);
  if (!Number.isFinite(naira) || naira < 0) return null;
  return Math.round(naira * 100);
}

// "3.5" -> 350 basis points (1 basis point = 0.01%). Must be positive — a
// bracket's markup can never be zero-or-negative, unlike a per-plan markup
// which can legitimately be "no markup" (blank input clears it).
function percentTextToBasisPoints(text: string): number | null {
  const cleaned = text.replace(/,/g, '').trim();
  if (!cleaned) return null;
  const percent = Number(cleaned);
  if (!Number.isFinite(percent) || percent <= 0) return null;
  return Math.round(percent * 100);
}

interface BracketDraft {
  min: string;
  max: string;
  type: 'flat' | 'percent';
  value: string;
}

const EMPTY_BRACKET_DRAFT: BracketDraft = { min: '', max: '', type: 'flat', value: '' };

function bracketToDraft(bracket: MarkupBracket): BracketDraft {
  return {
    min: (bracket.min_price_kobo / 100).toString(),
    max: (bracket.max_price_kobo / 100).toString(),
    type: bracket.markup_type,
    value: bracket.markup_type === 'flat'
      ? (bracket.markup_value / 100).toFixed(2)
      : (bracket.markup_value / 100).toFixed(2),
  };
}

export default function PricingPage() {
  const { role } = useAuth();
  const canEdit = role === 'super_admin';
  const [plans, setPlans] = useState<DataPlan[]>([]);
  const [overrides, setOverrides] = useState<PriceOverride[]>([]);
  const [servicePricing, setServicePricing] = useState<ServicePrice[]>([]);
  const [cabletvPlans, setCabletvPlans] = useState<CableTVPlan[]>([]);
  const [cabletvOverrides, setCabletvOverrides] = useState<CableTVOverride[]>([]);
  const [examPlans, setExamPlans] = useState<ExamPlan[]>([]);
  const [examOverrides, setExamOverrides] = useState<ExamOverride[]>([]);
  const [electricityFee, setElectricityFee] = useState<ElectricityFee | null>(null);
  const [markupBrackets, setMarkupBrackets] = useState<MarkupBracket[]>([]);
  const [engineConfig, setEngineConfig] = useState<PricingEngineConfig | null>(null);
  const [network, setNetwork] = useState('mtn');
  const [cabletvProvider, setCabletvProvider] = useState('gotv');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [planInputs, setPlanInputs] = useState<Record<string, string>>({});
  const [serviceCostInputs, setServiceCostInputs] = useState<Record<string, string>>({});
  const [serviceMarkupInputs, setServiceMarkupInputs] = useState<Record<string, string>>({});
  const [cabletvInputs, setCabletvInputs] = useState<Record<string, string>>({});
  const [examInputs, setExamInputs] = useState<Record<string, string>>({});
  const [electricityFeeInput, setElectricityFeeInput] = useState<string | undefined>(undefined);
  const [bracketDrafts, setBracketDrafts] = useState<Record<string, BracketDraft>>({});
  type ConfigDraft = {
    enabled: boolean; value_density_enabled: boolean; max_adjust: string; price_window: string; floor: string;
    discount: string; cashback: string;
  };
  const [configDraft, setConfigDraft] = useState<ConfigDraft | undefined>(undefined);
  const [busy, setBusy] = useState<string | null>(null);

  type PricingData = {
    plans: DataPlan[]; price_overrides: PriceOverride[]; service_pricing: ServicePrice[];
    cabletv_plans: CableTVPlan[]; cabletv_price_overrides: CableTVOverride[]; electricity_fee: ElectricityFee | null;
    exam_plans: ExamPlan[]; exam_price_overrides: ExamOverride[];
    data_markup_brackets: MarkupBracket[]; data_pricing_engine_config: PricingEngineConfig | null;
  };

  const fetchPricingData = () => callAdmin<PricingData>('admin-pricing-controls');

  const applyPricingData = (result: PricingData) => {
    setPlans(result.plans);
    setOverrides(result.price_overrides);
    setServicePricing(result.service_pricing);
    setCabletvPlans(result.cabletv_plans);
    setCabletvOverrides(result.cabletv_price_overrides);
    setElectricityFee(result.electricity_fee);
    setExamPlans(result.exam_plans);
    setExamOverrides(result.exam_price_overrides);
    setMarkupBrackets(result.data_markup_brackets);
    setEngineConfig(result.data_pricing_engine_config);
  };

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      applyPricingData(await fetchPricingData());
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
      // Refetch right before computing the final price — the provider's own
      // price syncs every few minutes, and the plan list on screen could be
      // stale if this tab has been open a while. Saving against a stale
      // provider price would silently bake in the wrong total.
      const fresh = await fetchPricingData();
      applyPricingData(fresh);
      const plan = fresh.plans.find((item) => item.id === planId && item.network === network);
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

  const serviceRow = (serviceKey: string) => servicePricing.find((item) => item.service_key === serviceKey);

  const saveServicePrice = async (serviceKey: string) => {
    setError(null);
    const row = serviceRow(serviceKey);
    const costText = serviceCostInputs[serviceKey] ?? (row ? (row.provider_cost_kobo / 100).toFixed(2) : '0');
    const markupText = serviceMarkupInputs[serviceKey] ?? (row ? ((row.price_kobo - row.provider_cost_kobo) / 100).toFixed(2) : '');
    const costKobo = nairaTextToMarkupKobo(costText);
    const markupKobo = nairaTextToMarkupKobo(markupText);
    if (costKobo === null || markupKobo === null) {
      setError('Enter a valid provider cost and markup (0 or more).');
      return;
    }
    const priceKobo = costKobo + markupKobo;
    if (priceKobo <= 0) {
      setError('The final price customers pay must be more than ₦0.');
      return;
    }
    setBusy(`service:${serviceKey}`);
    try {
      await callAdmin('admin-pricing-controls', {
        method: 'POST',
        body: { target: 'service', service_key: serviceKey, price_kobo: priceKobo, provider_cost_kobo: costKobo },
      });
      setServicePricing((current) => [
        ...current.filter((item) => item.service_key !== serviceKey),
        { service_key: serviceKey, price_kobo: priceKobo, provider_cost_kobo: costKobo, updated_at: new Date().toISOString() },
      ]);
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : 'Could not save the price');
    } finally {
      setBusy(null);
    }
  };

  const cabletvOverrideFor = (planId: string) =>
    cabletvOverrides.find((item) => item.provider === cabletvProvider && item.plan_id === planId);

  const saveCabletvPrice = async (planId: string) => {
    const key = `cabletv:${cabletvProvider}:${planId}`;
    const text = cabletvInputs[key];
    setError(null);
    setBusy(key);
    try {
      if (text === undefined || text.trim() === '') {
        await callAdmin('admin-pricing-controls', { method: 'POST', body: { target: 'cabletv', provider: cabletvProvider, plan_id: planId, clear: true } });
        setCabletvOverrides((current) => current.filter((item) => !(item.provider === cabletvProvider && item.plan_id === planId)));
        return;
      }
      const markupKobo = nairaTextToMarkupKobo(text);
      if (markupKobo === null) {
        setError('Enter a valid markup (0 or more), or leave it blank to use the provider price.');
        return;
      }
      // See savePlanPrice — refetch so the markup is added to the provider's
      // CURRENT price, not whatever was on screen when the tab was opened.
      const fresh = await fetchPricingData();
      applyPricingData(fresh);
      const plan = fresh.cabletv_plans.find((item) => item.provider === cabletvProvider && item.cabletv_plan_id === planId);
      if (!plan) {
        setError('Could not find this bouquet — try reloading the page.');
        return;
      }
      const priceKobo = plan.reseller_kobo + markupKobo;
      await callAdmin('admin-pricing-controls', { method: 'POST', body: { target: 'cabletv', provider: cabletvProvider, plan_id: planId, price_kobo: priceKobo } });
      setCabletvOverrides((current) => [
        ...current.filter((item) => !(item.provider === cabletvProvider && item.plan_id === planId)),
        { provider: cabletvProvider, plan_id: planId, price_kobo: priceKobo, updated_at: new Date().toISOString() },
      ]);
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : 'Could not save the price');
    } finally {
      setBusy(null);
    }
  };

  const examOverrideFor = (examId: string) => examOverrides.find((item) => item.exam_id === examId);

  const saveExamPrice = async (examId: string) => {
    const key = `exam:${examId}`;
    const text = examInputs[examId];
    setError(null);
    setBusy(key);
    try {
      if (text === undefined || text.trim() === '') {
        await callAdmin('admin-pricing-controls', { method: 'POST', body: { target: 'exam_pin', exam_id: examId, clear: true } });
        setExamOverrides((current) => current.filter((item) => item.exam_id !== examId));
        return;
      }
      const markupKobo = nairaTextToMarkupKobo(text);
      if (markupKobo === null) {
        setError('Enter a valid markup (0 or more), or leave it blank to use the provider price.');
        return;
      }
      // See savePlanPrice — refetch so the markup is added to the provider's
      // CURRENT price. This one matters most here: the exam catalog sync
      // runs every 15 minutes and can move customer_kobo while this tab sits
      // open.
      const fresh = await fetchPricingData();
      applyPricingData(fresh);
      const exam = fresh.exam_plans.find((item) => item.id === examId);
      if (!exam) {
        setError('Could not find this exam — try reloading the page.');
        return;
      }
      const priceKobo = exam.customer_kobo + markupKobo;
      await callAdmin('admin-pricing-controls', { method: 'POST', body: { target: 'exam_pin', exam_id: examId, price_kobo: priceKobo } });
      setExamOverrides((current) => [
        ...current.filter((item) => item.exam_id !== examId),
        { exam_id: examId, price_kobo: priceKobo, updated_at: new Date().toISOString() },
      ]);
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : 'Could not save the price');
    } finally {
      setBusy(null);
    }
  };

  const saveElectricityFee = async () => {
    setError(null);
    const text = electricityFeeInput ?? (electricityFee ? (electricityFee.fee_kobo / 100).toFixed(2) : '0');
    const feeKobo = nairaTextToMarkupKobo(text);
    if (feeKobo === null) {
      setError('Enter a valid fee (0 or more).');
      return;
    }
    setBusy('electricity_fee');
    try {
      await callAdmin('admin-pricing-controls', { method: 'POST', body: { target: 'electricity_fee', fee_kobo: feeKobo } });
      setElectricityFee({ fee_kobo: feeKobo, updated_at: new Date().toISOString() });
      setElectricityFeeInput(undefined);
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : 'Could not save the fee');
    } finally {
      setBusy(null);
    }
  };

  const draftFor = (key: string, bracket?: MarkupBracket): BracketDraft =>
    bracketDrafts[key] ?? (bracket ? bracketToDraft(bracket) : EMPTY_BRACKET_DRAFT);

  const setDraftField = (key: string, bracket: MarkupBracket | undefined, field: keyof BracketDraft, value: string) => {
    setBracketDrafts((current) => ({ ...current, [key]: { ...draftFor(key, bracket), [field]: value } }));
  };

  const saveBracket = async (bracketId: number | null) => {
    const key = bracketId === null ? 'bracket:new' : `bracket:${bracketId}`;
    const bracket = markupBrackets.find((item) => item.id === bracketId);
    const draft = draftFor(key, bracket);
    setError(null);

    const minKobo = nairaTextToMarkupKobo(draft.min);
    const maxKobo = nairaTextToMarkupKobo(draft.max);
    const value = draft.type === 'flat' ? nairaTextToMarkupKobo(draft.value) : percentTextToBasisPoints(draft.value);
    if (minKobo === null || maxKobo === null || maxKobo <= minKobo || value === null || value <= 0) {
      setError('Enter a valid price range and a markup greater than zero.');
      return;
    }

    setBusy(key);
    try {
      const result = await callAdmin<{ bracket_id: number }>('admin-pricing-controls', {
        method: 'POST',
        body: {
          target: 'data_markup_bracket', bracket_id: bracketId,
          min_price_kobo: minKobo, max_price_kobo: maxKobo, markup_type: draft.type, markup_value: value,
        },
      });
      const saved: MarkupBracket = {
        id: bracketId ?? result.bracket_id, min_price_kobo: minKobo, max_price_kobo: maxKobo,
        markup_type: draft.type, markup_value: value, updated_at: new Date().toISOString(),
      };
      setMarkupBrackets((current) => [...current.filter((item) => item.id !== saved.id), saved].sort((a, b) => a.min_price_kobo - b.min_price_kobo));
      setBracketDrafts((current) => { const next = { ...current }; delete next[key]; return next; });
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : 'Could not save the bracket');
    } finally {
      setBusy(null);
    }
  };

  const deleteBracket = async (bracketId: number) => {
    const key = `bracket:${bracketId}`;
    setError(null);
    setBusy(key);
    try {
      await callAdmin('admin-pricing-controls', { method: 'POST', body: { target: 'data_markup_bracket', bracket_id: bracketId, clear: true } });
      setMarkupBrackets((current) => current.filter((item) => item.id !== bracketId));
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : 'Could not delete the bracket');
    } finally {
      setBusy(null);
    }
  };

  const resolvedConfigDraft = (): ConfigDraft | null => {
    if (configDraft) return configDraft;
    if (!engineConfig) return null;
    return {
      enabled: engineConfig.enabled, value_density_enabled: engineConfig.value_density_enabled,
      max_adjust: engineConfig.value_density_max_adjust_percent.toString(),
      price_window: engineConfig.value_density_price_window_percent.toString(),
      floor: (engineConfig.min_markup_floor_kobo / 100).toFixed(2),
      discount: engineConfig.discount_percent_of_markup.toString(),
      cashback: engineConfig.cashback_percent_of_markup.toString(),
    };
  };

  const setConfigField = <K extends keyof ConfigDraft>(field: K, value: ConfigDraft[K]) => {
    const base = resolvedConfigDraft();
    if (!base) return;
    setConfigDraft({ ...base, [field]: value });
  };

  const saveEngineConfig = async () => {
    const draft = resolvedConfigDraft();
    if (!draft) return;
    setError(null);
    const maxAdjust = Number(draft.max_adjust);
    const priceWindow = Number(draft.price_window);
    const floorKobo = nairaTextToMarkupKobo(draft.floor);
    const discountPercent = Number(draft.discount);
    const cashbackPercent = Number(draft.cashback);
    if (!Number.isFinite(maxAdjust) || maxAdjust < 0 || maxAdjust > 100) {
      setError('Max adjust must be between 0 and 100.');
      return;
    }
    if (!Number.isFinite(priceWindow) || priceWindow <= 0 || priceWindow > 50) {
      setError('Price window must be between 0 and 50.');
      return;
    }
    if (floorKobo === null) {
      setError('Enter a valid markup floor.');
      return;
    }
    if (!Number.isFinite(discountPercent) || discountPercent < 0 || discountPercent > 100) {
      setError('Discount % of markup must be between 0 and 100.');
      return;
    }
    if (!Number.isFinite(cashbackPercent) || cashbackPercent < 0 || cashbackPercent > 100) {
      setError('Cashback % of markup must be between 0 and 100.');
      return;
    }
    setBusy('engine_config');
    try {
      await callAdmin('admin-pricing-controls', {
        method: 'POST',
        body: {
          target: 'data_pricing_engine_config', enabled: draft.enabled, value_density_enabled: draft.value_density_enabled,
          value_density_max_adjust_percent: maxAdjust, value_density_price_window_percent: priceWindow,
          min_markup_floor_kobo: floorKobo,
          discount_percent_of_markup: discountPercent, cashback_percent_of_markup: cashbackPercent,
        },
      });
      setEngineConfig({
        enabled: draft.enabled, value_density_enabled: draft.value_density_enabled,
        value_density_max_adjust_percent: maxAdjust, value_density_price_window_percent: priceWindow,
        min_markup_floor_kobo: floorKobo,
        discount_percent_of_markup: discountPercent, cashback_percent_of_markup: cashbackPercent,
        updated_at: new Date().toISOString(),
      });
      setConfigDraft(undefined);
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : 'Could not save the settings');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <h2>Pricing</h2>
      <p className="muted">
        Data plans and cable TV: enter a markup to add on top of the provider's price — leave it blank to charge the provider's price with no markup. NIN &amp; BVN: enter what the provider bills you plus your markup. Electricity: a flat fee added to whatever amount the customer tops up. Changes apply to the very next purchase.
      </p>
      {!canEdit && <p className="muted">You have view-only access. Only super admins can change prices.</p>}
      {error && <div className="error-text">{error}</div>}

      {loading ? <p className="muted">Loading…</p> : (
        <>
          <div className="card">
            <h3>Automatic Data Markup Engine</h3>
            <p className="muted">
              Runs on every catalogue sync (every 5 minutes), across mtn, glo, 9mobile and airtel at once — a new plan the provider adds gets priced automatically, no manual entry needed. A manual markup set below in Data Plan Pricing still overrides this for that one plan. Value-density lowers markup on the best-value plan among similarly-priced siblings and raises it on the weaker one.
            </p>
            {engineConfig && (() => {
              const draft = resolvedConfigDraft()!;
              return (
                <div className="engine-settings">
                  <div className="engine-toggles">
                    <label className="checkbox-row">
                      <input
                        type="checkbox" checked={draft.enabled} disabled={!canEdit}
                        onChange={(event) => setConfigField('enabled', event.target.checked)}
                      />
                      Engine enabled
                    </label>
                    <label className="checkbox-row">
                      <input
                        type="checkbox" checked={draft.value_density_enabled} disabled={!canEdit}
                        onChange={(event) => setConfigField('value_density_enabled', event.target.checked)}
                      />
                      Value-density adjustment
                    </label>
                  </div>
                  <div className="engine-config-grid">
                    <label>
                      Max adjust %
                      <input
                        className="mono" disabled={!canEdit}
                        value={draft.max_adjust}
                        onChange={(event) => setConfigField('max_adjust', event.target.value)}
                      />
                    </label>
                    <label>
                      Sibling price window %
                      <input
                        className="mono" disabled={!canEdit}
                        value={draft.price_window}
                        onChange={(event) => setConfigField('price_window', event.target.value)}
                      />
                    </label>
                    <label>
                      Markup floor (₦)
                      <input
                        className="mono" disabled={!canEdit}
                        value={draft.floor}
                        onChange={(event) => setConfigField('floor', event.target.value)}
                      />
                    </label>
                    <label>
                      Discount % of markup
                      <input
                        className="mono" disabled={!canEdit}
                        value={draft.discount}
                        onChange={(event) => setConfigField('discount', event.target.value)}
                      />
                    </label>
                    <label>
                      Cashback % of markup
                      <input
                        className="mono" disabled={!canEdit}
                        value={draft.cashback}
                        onChange={(event) => setConfigField('cashback', event.target.value)}
                      />
                    </label>
                  </div>
                  {canEdit && (
                    <div className="engine-config-actions">
                      <button className="primary" disabled={busy === 'engine_config'} onClick={() => void saveEngineConfig()}>
                        Save settings
                      </button>
                    </div>
                  )}
                </div>
              );
            })()}
            <p className="muted" style={{ marginTop: -4, marginBottom: 16 }}>
              Discount is applied to the real charged price shown below. Cashback is computed and shown for your visibility only — there's no customer-facing cashback balance yet, so it is not shown to customers or promised anywhere in the app.
            </p>

            <table>
              <thead><tr><th>Price from</th><th>Price to</th><th>Type</th><th>Value</th>{canEdit && <th />}</tr></thead>
              <tbody>
                {markupBrackets.map((bracket) => {
                  const key = `bracket:${bracket.id}`;
                  const draft = draftFor(key, bracket);
                  return (
                    <tr key={bracket.id}>
                      <td><input className="mono" style={{ width: 90, textAlign: 'right' }} disabled={!canEdit} value={draft.min} onChange={(e) => setDraftField(key, bracket, 'min', e.target.value)} /></td>
                      <td><input className="mono" style={{ width: 90, textAlign: 'right' }} disabled={!canEdit} value={draft.max} onChange={(e) => setDraftField(key, bracket, 'max', e.target.value)} /></td>
                      <td>
                        <select disabled={!canEdit} value={draft.type} onChange={(e) => setDraftField(key, bracket, 'type', e.target.value)}>
                          <option value="flat">Flat ₦</option>
                          <option value="percent">Percent</option>
                        </select>
                      </td>
                      <td><input className="mono" style={{ width: 70, textAlign: 'right' }} disabled={!canEdit} value={draft.value} onChange={(e) => setDraftField(key, bracket, 'value', e.target.value)} /></td>
                      {canEdit && (
                        <td style={{ display: 'flex', gap: 6 }}>
                          <button className="primary" style={{ padding: '6px 12px', fontSize: 12 }} disabled={busy === key} onClick={() => void saveBracket(bracket.id)}>Save</button>
                          <button style={{ padding: '6px 12px', fontSize: 12 }} disabled={busy === key} onClick={() => void deleteBracket(bracket.id)}>Delete</button>
                        </td>
                      )}
                    </tr>
                  );
                })}
                {canEdit && (
                  <tr>
                    <td><input className="mono" style={{ width: 90, textAlign: 'right' }} placeholder="0" value={draftFor('bracket:new').min} onChange={(e) => setDraftField('bracket:new', undefined, 'min', e.target.value)} /></td>
                    <td><input className="mono" style={{ width: 90, textAlign: 'right' }} placeholder="0" value={draftFor('bracket:new').max} onChange={(e) => setDraftField('bracket:new', undefined, 'max', e.target.value)} /></td>
                    <td>
                      <select value={draftFor('bracket:new').type} onChange={(e) => setDraftField('bracket:new', undefined, 'type', e.target.value)}>
                        <option value="flat">Flat ₦</option>
                        <option value="percent">Percent</option>
                      </select>
                    </td>
                    <td><input className="mono" style={{ width: 70, textAlign: 'right' }} placeholder="0" value={draftFor('bracket:new').value} onChange={(e) => setDraftField('bracket:new', undefined, 'value', e.target.value)} /></td>
                    <td>
                      <button className="primary" style={{ padding: '6px 12px', fontSize: 12 }} disabled={busy === 'bracket:new'} onClick={() => void saveBracket(null)}>Add bracket</button>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="card">
            <h3>Data Plan Pricing</h3>
            <p className="muted">Showing available and unavailable plans — pricing works independently of availability, set on the Service Controls page.</p>
            <div className="row" style={{ marginBottom: 12 }}>
              <label htmlFor="pricing-network">Network</label>
              <select id="pricing-network" value={network} onChange={(event) => setNetwork(event.target.value)}>
                {NETWORKS.map((item) => <option key={item} value={item}>{item.toUpperCase()}</option>)}
              </select>
            </div>
            {networkPlans.length === 0 ? <p className="muted">No synced plans for this network.</p> : (() => {
              // Manual override: keep is just override price minus provider
              // cost — discount/cashback are engine-only concepts, they don't
              // apply once an admin has hand-set a final price. Auto-priced:
              // keep is markup minus discount minus cashback — the true net
              // margin AS IF cashback were already being paid out (it isn't
              // credited to anyone yet), so this is the honest full-rollout
              // number, not what's actually pocketed today.
              const keepFor = (plan: DataPlan): number | null => {
                const override = overrideFor(plan.id);
                if (override) return override.price_kobo - plan.reseller_kobo;
                if (plan.computed_markup_kobo === null) return null;
                return plan.computed_markup_kobo - (plan.computed_discount_kobo ?? 0) - (plan.computed_cashback_kobo ?? 0);
              };
              const keepValues = networkPlans.map(keepFor).filter((v): v is number => v !== null);
              const avgKeepKobo = keepValues.length > 0 ? Math.round(keepValues.reduce((a, b) => a + b, 0) / keepValues.length) : null;

              return (
                <>
                  <p className="muted">
                    {networkPlans.length} plans shown{avgKeepKobo !== null && <> · average you keep per sale: <strong>{formatNaira(avgKeepKobo)}</strong> (after discount + cashback)</>}
                  </p>
                  <table>
                    <thead>
                      <tr><th>Plan</th><th>Status</th><th>Provider Price</th><th>Auto Price</th><th title="Admin visibility only — not shown to customers yet">Discount / Cashback</th><th title="Markup minus discount minus cashback — net margin as if cashback were already being paid out">You Keep</th><th>Your Manual Markup</th><th>Customer Pays</th>{canEdit && <th />}</tr>
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
                        // What the customer actually pays if this row is left
                        // blank: the manual override if set, else the auto-engine's
                        // computed price, else raw provider cost — same order the
                        // server resolves it in.
                        const customerPaysKobo = previewMarkupKobo === null
                          ? null
                          : (draftText?.trim() ? plan.reseller_kobo + previewMarkupKobo
                            : (override ? override.price_kobo : (plan.computed_price_kobo ?? plan.reseller_kobo)));
                        const keepKobo = keepFor(plan);
                        return (
                          <tr key={plan.id}>
                            <td>{plan.name} · {plan.validity}</td>
                            <td><span className={`badge ${plan.available ? 'enabled' : 'disabled'}`}>{plan.available ? 'Available' : 'Unavailable'}</span></td>
                            <td className="mono muted">{formatNaira(plan.reseller_kobo)}</td>
                            <td className="mono muted">{plan.computed_price_kobo === null ? '—' : formatNaira(plan.computed_price_kobo)}</td>
                            <td className="mono muted">
                              {plan.computed_discount_kobo === null ? '—' : `${formatNaira(plan.computed_discount_kobo)} / ${formatNaira(plan.computed_cashback_kobo ?? 0)}`}
                            </td>
                            <td className="mono">{keepKobo === null ? '—' : formatNaira(keepKobo)}</td>
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
                </>
              );
            })()}
          </div>

          <div className="card">
            <h3>Cable TV Pricing</h3>
            <p className="muted">GOTV, DSTV, and Startimes bouquets — same markup model as data plans.</p>
            <div className="row" style={{ marginBottom: 12 }}>
              <label htmlFor="pricing-cabletv-provider">Provider</label>
              <select id="pricing-cabletv-provider" value={cabletvProvider} onChange={(event) => setCabletvProvider(event.target.value)}>
                {CABLETV_PROVIDERS.map((item) => <option key={item} value={item}>{item.toUpperCase()}</option>)}
              </select>
            </div>
            {cabletvPlans.filter((plan) => plan.provider === cabletvProvider).length === 0 ? <p className="muted">No synced bouquets for this provider.</p> : (
              <table>
                <thead>
                  <tr><th>Bouquet</th><th>Status</th><th>Provider Price</th><th>Your Markup</th><th>Customer Pays</th>{canEdit && <th />}</tr>
                </thead>
                <tbody>
                  {cabletvPlans.filter((plan) => plan.provider === cabletvProvider).map((plan) => {
                    const key = `cabletv:${cabletvProvider}:${plan.cabletv_plan_id}`;
                    const override = cabletvOverrideFor(plan.cabletv_plan_id);
                    const inputValue = cabletvInputs[key] ?? (override ? ((override.price_kobo - plan.reseller_kobo) / 100).toFixed(2) : '');
                    const draftText = cabletvInputs[key];
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
                            onChange={(event) => setCabletvInputs((current) => ({ ...current, [key]: event.target.value }))}
                          />
                        </td>
                        <td className="mono">{customerPaysKobo === null ? '—' : formatNaira(customerPaysKobo)}</td>
                        {canEdit && (
                          <td>
                            <button className="primary" style={{ padding: '6px 12px', fontSize: 12 }} disabled={busy === key} onClick={() => void saveCabletvPrice(plan.cabletv_plan_id)}>
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
            <p className="muted">Provider Cost is what Prembly/CheckMyNINBVN actually bill you — set manually, since it isn't fetched automatically.</p>
            <table>
              <thead><tr><th>Service</th><th>Provider Cost</th><th>Your Markup</th><th>Customer Pays</th>{canEdit && <th />}</tr></thead>
              <tbody>
                {SERVICE_ORDER.map((serviceKey) => {
                  const row = serviceRow(serviceKey);
                  const costValue = serviceCostInputs[serviceKey] ?? (row ? (row.provider_cost_kobo / 100).toFixed(2) : '0.00');
                  const markupValue = serviceMarkupInputs[serviceKey] ?? (row ? ((row.price_kobo - row.provider_cost_kobo) / 100).toFixed(2) : '');
                  const costDraftText = serviceCostInputs[serviceKey];
                  const markupDraftText = serviceMarkupInputs[serviceKey];
                  const previewCostKobo = costDraftText === undefined
                    ? (row ? row.provider_cost_kobo : 0)
                    : (costDraftText.trim() === '' ? 0 : nairaTextToMarkupKobo(costDraftText));
                  const previewMarkupKobo = markupDraftText === undefined
                    ? (row ? row.price_kobo - row.provider_cost_kobo : null)
                    : (markupDraftText.trim() === '' ? 0 : nairaTextToMarkupKobo(markupDraftText));
                  const customerPaysKobo = (previewCostKobo === null || previewMarkupKobo === null) ? null : previewCostKobo + previewMarkupKobo;
                  return (
                    <tr key={serviceKey}>
                      <td>{SERVICE_LABELS[serviceKey]}</td>
                      <td>
                        <input
                          className="mono"
                          style={{ width: 100, textAlign: 'right' }}
                          value={costValue}
                          disabled={!canEdit}
                          onChange={(event) => setServiceCostInputs((current) => ({ ...current, [serviceKey]: event.target.value }))}
                        />
                      </td>
                      <td>
                        <input
                          className="mono"
                          style={{ width: 100, textAlign: 'right' }}
                          placeholder="0"
                          value={markupValue}
                          disabled={!canEdit}
                          onChange={(event) => setServiceMarkupInputs((current) => ({ ...current, [serviceKey]: event.target.value }))}
                        />
                      </td>
                      <td className="mono">{customerPaysKobo === null ? '—' : formatNaira(customerPaysKobo)}</td>
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

          <div className="card">
            <h3>Exam PIN Pricing</h3>
            <p className="muted">
              Provider Price is synced from VTUnaija every 15 minutes and re-syncs regardless of any markup set here — your markup is stored separately and re-applied automatically on top of whatever the provider is currently charging.
            </p>
            <table>
              <thead><tr><th>Exam</th><th>Status</th><th>Provider Price</th><th>Your Markup</th><th>Customer Pays</th>{canEdit && <th />}</tr></thead>
              <tbody>
                {examPlans.map((exam) => {
                  const key = `exam:${exam.id}`;
                  const override = examOverrideFor(exam.id);
                  const inputValue = examInputs[exam.id] ?? (override ? ((override.price_kobo - exam.customer_kobo) / 100).toFixed(2) : '');
                  const draftText = examInputs[exam.id];
                  const previewMarkupKobo = draftText === undefined
                    ? (override ? override.price_kobo - exam.customer_kobo : 0)
                    : (draftText.trim() === '' ? 0 : nairaTextToMarkupKobo(draftText));
                  const customerPaysKobo = previewMarkupKobo === null ? null : exam.customer_kobo + previewMarkupKobo;
                  const statusLabel = exam.requires_review ? 'Needs Review' : (exam.available ? 'Available' : 'Unavailable');
                  return (
                    <tr key={exam.id}>
                      <td>{exam.name}</td>
                      <td><span className={`badge ${exam.available && !exam.requires_review ? 'enabled' : 'disabled'}`}>{statusLabel}</span></td>
                      <td className="mono muted">{formatNaira(exam.customer_kobo)}</td>
                      <td>
                        <input
                          className="mono"
                          style={{ width: 110, textAlign: 'right', borderColor: override ? 'var(--warning)' : undefined, background: override ? '#fffbeb' : undefined }}
                          placeholder="0"
                          value={inputValue}
                          disabled={!canEdit}
                          onChange={(event) => setExamInputs((current) => ({ ...current, [exam.id]: event.target.value }))}
                        />
                      </td>
                      <td className="mono">{customerPaysKobo === null ? '—' : formatNaira(customerPaysKobo)}</td>
                      {canEdit && (
                        <td>
                          <button className="primary" style={{ padding: '6px 12px', fontSize: 12 }} disabled={busy === key} onClick={() => void saveExamPrice(exam.id)}>
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

          <div className="card">
            <h3>Electricity Convenience Fee</h3>
            <p className="muted">
              A flat fee added to whatever amount the customer tops up (e.g. they enter ₦5,000, you charge them ₦5,000 + this fee — the DISCO still only credits the ₦5,000). Applies to all DISCOs. Set to 0 to disable.
            </p>
            <div className="row" style={{ gap: 8, alignItems: 'center' }}>
              <input
                className="mono"
                style={{ width: 110, textAlign: 'right' }}
                value={electricityFeeInput ?? (electricityFee ? (electricityFee.fee_kobo / 100).toFixed(2) : '0.00')}
                disabled={!canEdit}
                onChange={(event) => setElectricityFeeInput(event.target.value)}
              />
              {canEdit && (
                <button className="primary" style={{ padding: '6px 12px', fontSize: 12 }} disabled={busy === 'electricity_fee'} onClick={() => void saveElectricityFee()}>
                  Save
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
