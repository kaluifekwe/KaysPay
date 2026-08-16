// Automatic markup engine for VTUnaija data plans (migration 122). Pure
// computation, no I/O — callers load brackets/config/rows from the database
// and pass them in, which keeps this testable without a live connection.

export interface MarkupBracket {
  min_price_kobo: number;
  max_price_kobo: number;
  markup_type: "flat" | "percent";
  /** Kobo for 'flat'; basis points (1 = 0.01%) for 'percent'. */
  markup_value: number;
}

export interface PricingEngineConfig {
  enabled: boolean;
  value_density_enabled: boolean;
  value_density_max_adjust_percent: number;
  value_density_price_window_percent: number;
  min_markup_floor_kobo: number;
}

export interface CatalogPricingInput {
  id: string;
  network: string;
  /** Plan display name, e.g. "1GB (AwoofData)" — parsed for its data size. */
  name: string;
  reseller_kobo: number;
}

export interface ComputedPlanMarkup {
  id: string;
  computed_markup_kobo: number;
  computed_price_kobo: number;
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

function findBracket(brackets: MarkupBracket[], priceKobo: number): MarkupBracket | null {
  return brackets.find((b) => priceKobo >= b.min_price_kobo && priceKobo < b.max_price_kobo) ?? null;
}

function baseMarkupKobo(bracket: MarkupBracket, priceKobo: number): number {
  if (bracket.markup_type === "flat") return bracket.markup_value;
  return Math.round((priceKobo * bracket.markup_value) / 10000);
}

/**
 * Computes an automatic markup for every plan in a live catalogue snapshot.
 * Two layers:
 * 1. Base markup from the matching price bracket (admin-configured).
 * 2. An optional value-density adjustment: among plans on the SAME network
 *    priced within `value_density_price_window_percent` of each other, the
 *    one giving more data per naira gets less markup (protect the best
 *    deal), the weaker one gets more (already a worse deal regardless).
 *    Bounded to +/- `value_density_max_adjust_percent` of the base markup,
 *    and never allowed below `min_markup_floor_kobo` overall — the
 *    adjustment can only ever shrink margin, never erase or invert it.
 *
 * Returns a map keyed by plan id; a plan with no matching bracket or an
 * unparseable size (for the density step only) is simply left out rather
 * than guessed.
 */
export function computeCatalogMarkup(
  rows: CatalogPricingInput[],
  brackets: MarkupBracket[],
  config: PricingEngineConfig,
): Map<string, ComputedPlanMarkup> {
  const result = new Map<string, ComputedPlanMarkup>();
  if (!config.enabled || brackets.length === 0) return result;

  const byNetwork = new Map<string, CatalogPricingInput[]>();
  for (const row of rows) {
    if (!byNetwork.has(row.network)) byNetwork.set(row.network, []);
    byNetwork.get(row.network)!.push(row);
  }

  for (const networkRows of byNetwork.values()) {
    const withDensity = networkRows.map((row) => {
      const mb = parseDataSizeToMb(row.name);
      return { row, density: mb !== null && row.reseller_kobo > 0 ? mb / row.reseller_kobo : null };
    });

    for (const entry of withDensity) {
      const bracket = findBracket(brackets, entry.row.reseller_kobo);
      if (!bracket) continue;
      let markup = baseMarkupKobo(bracket, entry.row.reseller_kobo);

      if (config.value_density_enabled && entry.density !== null) {
        const windowFraction = config.value_density_price_window_percent / 100;
        const siblings = withDensity.filter((other) =>
          other !== entry &&
          other.density !== null &&
          Math.abs(other.row.reseller_kobo - entry.row.reseller_kobo) / entry.row.reseller_kobo <= windowFraction
        );
        if (siblings.length > 0) {
          const densities = [entry.density, ...siblings.map((s) => s.density as number)];
          const min = Math.min(...densities);
          const max = Math.max(...densities);
          if (max > min) {
            // -1 = worst value in the sibling group, +1 = best value.
            const score = ((entry.density - min) / (max - min)) * 2 - 1;
            const adjustFraction = (config.value_density_max_adjust_percent / 100) * score;
            markup = Math.round(markup * (1 - adjustFraction));
          }
        }
      }

      markup = Math.max(markup, config.min_markup_floor_kobo);
      result.set(entry.row.id, {
        id: entry.row.id,
        computed_markup_kobo: markup,
        computed_price_kobo: entry.row.reseller_kobo + markup,
      });
    }
  }

  return result;
}
