// Automatic markup engine for VTUnaija data plans (migration 122). Pure
// computation, no I/O — callers load brackets/config/rows from the database
// and pass them in, which keeps this testable without a live connection.

export const DATA_PRICING_ENGINE_VERSION = 2;

export interface MarkupBracket {
  min_price_kobo: number;
  max_price_kobo: number;
  markup_type: "flat" | "percent";
  /** Kobo for 'flat'; basis points (1 = 0.01%) for 'percent'. */
  markup_value: number;
  /** Minimum gross markup for this price band, in kobo. */
  min_markup_kobo: number;
  /** Minimum retained margin after discount and cashback, in kobo. */
  min_net_margin_kobo: number;
}

export interface PricingEngineConfig {
  enabled: boolean;
  value_density_enabled: boolean;
  value_density_max_adjust_percent: number;
  value_density_price_window_percent: number;
  min_markup_floor_kobo: number;
  /** Percent of THIS plan's own markup taken off the charged price. Capped
   * at 100 by the database, so the charge can reach cost but never go below
   * it — never a percent of price, which could push below cost on a plan
   * with a large markup. */
  discount_percent_of_markup: number;
  /** Percent of this plan's own markup credited through the cashback ledger. */
  cashback_percent_of_markup: number;
}

export interface CatalogPricingInput {
  id: string;
  network: string;
  /** Plan display name, e.g. "1GB (AwoofData)" — parsed for its data size. */
  name: string;
  validity?: string;
  family_key?: string;
  reseller_kobo: number;
}

export interface ComputedPlanMarkup {
  id: string;
  computed_markup_kobo: number;
  /** Reseller cost + markup, before any discount — the "was" price. */
  computed_list_price_kobo: number;
  computed_discount_kobo: number;
  /** Amount credited through the cashback ledger after a successful sale. */
  computed_cashback_kobo: number;
  /** What's actually charged: list price minus discount. */
  computed_price_kobo: number;
  normalized_data_mb: number | null;
  validity_days: number | null;
  validity_adjustment_kobo: number;
  requires_pricing_review: boolean;
  pricing_review_reason: string | null;
  pricing_engine_version: number;
}

/**
 * Parses the leading data-size token out of a plan name — "1GB", "500MB",
 * "16.5GB+10mins", "150GB 2-Month Plan" all resolve; anything without a
 * recognizable GB/MB token returns null so callers skip value-density
 * comparison for that row instead of guessing a size.
 */
export function parseDataSizeToMb(text: string): number | null {
  const match = text.match(/(\d+(?:\.\d+)?)\s*(GB|MB)/i);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  return match[2].toUpperCase() === "GB" ? value * 1024 : value;
}

export function parseValidityDays(text: string): number | null {
  const normalized = text.trim().toLowerCase();
  const match = normalized.match(/(\d+(?:\.\d+)?)\s*(day|days|week|weeks|month|months)/);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = match[2];
  if (unit.startsWith("week")) return Math.round(value * 7);
  if (unit.startsWith("month")) return Math.round(value * 30);
  return Math.round(value);
}

export function validityAdjustmentKobo(days: number | null): number {
  if (days === null || days <= 7) return 0;
  if (days <= 14) return 500;
  if (days <= 30) return 1000;
  return 2000;
}

function findBracket(brackets: MarkupBracket[], priceKobo: number): MarkupBracket | null {
  return brackets.find((b) => priceKobo >= b.min_price_kobo && priceKobo < b.max_price_kobo) ?? null;
}

function baseMarkupKobo(bracket: MarkupBracket, priceKobo: number): number {
  if (bracket.markup_type === "flat") return bracket.markup_value;
  return Math.round((priceKobo * bracket.markup_value) / 10000);
}

/**
 * Computes an automatic markup for every plan in a live catalogue snapshot.
 * Uses the greater of the bracket percentage/flat target and its gross
 * naira floor. A second per-bracket floor protects the amount retained after
 * discount and cashback. Value-density settings are intentionally ignored:
 * data volume must never silently reduce the margin on a higher-cost plan.
 *
 * On top of that, a discount and a cashback amount are each taken as a
 * percentage of THIS plan's own final markup (never of price, and never a
 * flat naira figure) — so neither can scale wrong on an unusually cheap or
 * expensive plan. The discount is subtracted from the charged price; the
 * cashback amount is computed but not applied anywhere yet (see
 * PricingEngineConfig).
 *
 * Returns a map keyed by plan id; a plan with no matching bracket is left
 * out rather than guessed.
 */
export function computeCatalogMarkup(
  rows: CatalogPricingInput[],
  brackets: MarkupBracket[],
  config: PricingEngineConfig,
): Map<string, ComputedPlanMarkup> {
  const result = new Map<string, ComputedPlanMarkup>();
  if (!config.enabled || brackets.length === 0) return result;

  for (const row of rows) {
      const bracket = findBracket(brackets, row.reseller_kobo);
      if (!bracket) continue;
      const retainedPercent = 100 - config.discount_percent_of_markup - config.cashback_percent_of_markup;
      if (retainedPercent <= 0 && bracket.min_net_margin_kobo > 0) continue;
      const netProtectedMarkup = bracket.min_net_margin_kobo > 0
        // Discount and cashback are rounded independently to whole naira.
        // Reserve N2 so those two rounding operations can never shave the
        // retained amount below the configured net floor.
        ? Math.ceil((bracket.min_net_margin_kobo * 100) / retainedPercent) +
          (config.discount_percent_of_markup > 0 ? 200 : 0)
        : 0;
      const markup = Math.max(
        baseMarkupKobo(bracket, row.reseller_kobo),
        bracket.min_markup_kobo,
        netProtectedMarkup,
        config.min_markup_floor_kobo,
      );
      const dataMb = parseDataSizeToMb(row.name);
      const validityDays = parseValidityDays(row.validity ?? "");
      const validityAdjustment = validityAdjustmentKobo(validityDays);
      const adjustedMarkup = markup + validityAdjustment;
      const rawListPrice = row.reseller_kobo + adjustedMarkup;
      const rawDiscount = adjustedMarkup * (config.discount_percent_of_markup / 100);
      const rawPrice = rawListPrice - rawDiscount;
      const rawCashback = adjustedMarkup * (config.cashback_percent_of_markup / 100);

      // Round the customer-facing numbers to the nearest whole naira — a
      // discount subtracted from a markup often leaves an odd kobo remainder
      // (e.g. 30% of an N35 markup is N10.50), and nobody should be quoted
      // or charged a fractional-naira price for airtime/data. Both list
      // price and charged price round UP (never down), which is what keeps
      // the "never below provider cost" guarantee intact through rounding —
      // rounding either of them down could, in a rare edge case (a small
      // markup near the floor combined with a large discount percent),
      // shave the charge below cost by a few kobo. Discount is then derived
      // as the difference between the two ALREADY-rounded numbers, rather
      // than rounded on its own, so "was minus now" always exactly equals
      // the discount shown — no separate rounding to drift out of sync.
      const listPrice = Math.ceil(rawListPrice / 100) * 100;
      const price = Math.ceil(rawPrice / 100) * 100;
      const discount = listPrice - price;
      const cashback = Math.round(rawCashback / 100) * 100;

      result.set(row.id, {
        id: row.id,
        computed_markup_kobo: adjustedMarkup,
        computed_list_price_kobo: listPrice,
        computed_discount_kobo: discount,
        computed_cashback_kobo: cashback,
        computed_price_kobo: price,
        normalized_data_mb: dataMb,
        validity_days: validityDays,
        validity_adjustment_kobo: validityAdjustment,
        requires_pricing_review: dataMb === null || validityDays === null,
        pricing_review_reason: dataMb === null
          ? "Data volume could not be classified"
          : validityDays === null ? "Validity could not be classified" : null,
        pricing_engine_version: DATA_PRICING_ENGINE_VERSION,
      });
  }

  // Flag strictly dominated offers only within the same network and family.
  // This avoids comparing unlike products such as social/night and gifting.
  for (const row of rows) {
    const priced = result.get(row.id);
    if (!priced || priced.normalized_data_mb === null || priced.validity_days === null) continue;
    const pricedDataMb = priced.normalized_data_mb;
    const pricedValidityDays = priced.validity_days;
    const dominatedBy = rows.find((other) => {
      if (other.id === row.id || other.network !== row.network ||
          (other.family_key ?? "other") !== (row.family_key ?? "other")) return false;
      const candidate = result.get(other.id);
      if (!candidate || candidate.normalized_data_mb === null || candidate.validity_days === null) return false;
      return candidate.computed_price_kobo <= priced.computed_price_kobo &&
        candidate.normalized_data_mb >= pricedDataMb &&
        candidate.validity_days >= pricedValidityDays &&
        (candidate.computed_price_kobo < priced.computed_price_kobo ||
          candidate.normalized_data_mb > pricedDataMb || candidate.validity_days > pricedValidityDays);
    });
    if (dominatedBy) {
      priced.requires_pricing_review = true;
      priced.pricing_review_reason = `Lower-value offer than ${dominatedBy.name}`.slice(0, 240);
    }
  }

  return result;
}
