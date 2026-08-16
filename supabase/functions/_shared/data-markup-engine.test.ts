import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { computeCatalogMarkup, parseDataSizeToMb } from "./data-markup-engine.ts";

const BRACKETS = [
  { min_price_kobo: 0, max_price_kobo: 15000, markup_type: "flat" as const, markup_value: 1200 },
  { min_price_kobo: 15000, max_price_kobo: 40000, markup_type: "flat" as const, markup_value: 2000 },
  { min_price_kobo: 40000, max_price_kobo: 100000, markup_type: "flat" as const, markup_value: 3500 },
  { min_price_kobo: 100000, max_price_kobo: 300000, markup_type: "percent" as const, markup_value: 350 },
];

const CONFIG = {
  enabled: true,
  value_density_enabled: true,
  value_density_max_adjust_percent: 30,
  value_density_price_window_percent: 10,
  min_markup_floor_kobo: 100,
  discount_percent_of_markup: 30,
  cashback_percent_of_markup: 10,
};

Deno.test("parseDataSizeToMb reads GB and MB tokens", () => {
  assertEquals(parseDataSizeToMb("1GB (AwoofData)"), 1024);
  assertEquals(parseDataSizeToMb("500MB (DataShare4)"), 500);
  assertEquals(parseDataSizeToMb("16.5GB+10mins (GiftingPlan)"), 16.5 * 1024);
  assertEquals(parseDataSizeToMb("Do Not Buy MTN AwoofData"), null);
});

Deno.test("applies the matching bracket's flat markup with no siblings nearby", () => {
  const rows = [{ id: "a", network: "mtn", name: "1GB (AwoofData)", reseller_kobo: 21500 }];
  const result = computeCatalogMarkup(rows, BRACKETS, { ...CONFIG, value_density_enabled: false });
  const plan = result.get("a")!;
  assertEquals(plan.computed_markup_kobo, 2000);
  assertEquals(plan.computed_list_price_kobo, 23500);
  // 30% of 2000 markup = 600 discount, charged price = list - discount
  assertEquals(plan.computed_discount_kobo, 600);
  assertEquals(plan.computed_price_kobo, 22900);
  // 10% of 2000 markup = 200 cashback (computed, not credited anywhere yet)
  assertEquals(plan.computed_cashback_kobo, 200);
});

Deno.test("never quotes or charges a fractional-naira price, even when the discount leaves an odd kobo remainder", () => {
  // The real bug: MTN 2GB (AwoofData) at N420 (42000 kobo), N35 markup, 30%
  // discount of markup = N10.50 (1050 kobo) — an odd remainder that used to
  // surface as "N444.5" on the customer-facing price before this fix.
  const rows = [{ id: "a", network: "mtn", name: "2GB (AwoofData)", reseller_kobo: 42000 }];
  const result = computeCatalogMarkup(rows, BRACKETS, { ...CONFIG, value_density_enabled: false });
  const plan = result.get("a")!;
  assertEquals(plan.computed_list_price_kobo % 100, 0);
  assertEquals(plan.computed_price_kobo % 100, 0);
  assertEquals(plan.computed_discount_kobo % 100, 0);
  assertEquals(plan.computed_cashback_kobo % 100, 0);
  // Rounds UP to the next whole naira, never down — keeps the charged price
  // from ever dipping below list price minus the true discount.
  assertEquals(plan.computed_list_price_kobo, 45500);
  assertEquals(plan.computed_price_kobo, 44500);
  assertEquals(plan.computed_discount_kobo, 1000);
  // "was" minus "now" always exactly equals the discount shown, since
  // discount is derived from the two already-rounded numbers.
  assertEquals(plan.computed_list_price_kobo - plan.computed_price_kobo, plan.computed_discount_kobo);
});

Deno.test("a 100 percent discount charges exactly provider cost, never below it", () => {
  const rows = [{ id: "a", network: "mtn", name: "1GB (AwoofData)", reseller_kobo: 21500 }];
  const result = computeCatalogMarkup(rows, BRACKETS, {
    ...CONFIG, value_density_enabled: false, discount_percent_of_markup: 100,
  });
  const plan = result.get("a")!;
  assertEquals(plan.computed_discount_kobo, plan.computed_markup_kobo);
  assertEquals(plan.computed_price_kobo, 21500);
});

Deno.test("applies percentage brackets on the provider price", () => {
  const rows = [{ id: "a", network: "mtn", name: "3GB (DataShare)", reseller_kobo: 112000 }];
  const result = computeCatalogMarkup(rows, BRACKETS, { ...CONFIG, value_density_enabled: false });
  // 3.5% of 112000 = 3920
  assertEquals(result.get("a")?.computed_markup_kobo, 3920);
});

Deno.test("gives the best-value sibling less markup and the weaker one more, at the same price", () => {
  // The real 97.4-naira MTN pair: 200MB is nearly double the data of 110MB
  // at the identical provider price.
  const rows = [
    { id: "better", network: "mtn", name: "200MB (Social Media Data)", reseller_kobo: 9740 },
    { id: "weaker", network: "mtn", name: "110MB (GiftingPlan)", reseller_kobo: 9740 },
  ];
  const result = computeCatalogMarkup(rows, BRACKETS, CONFIG);
  const better = result.get("better")!;
  const weaker = result.get("weaker")!;
  // Base bracket markup here is 1200 kobo; best value pulls below it, worst rises above it.
  if (!(better.computed_markup_kobo < 1200)) throw new Error("best-value plan should be marked up less than base");
  if (!(weaker.computed_markup_kobo > 1200)) throw new Error("weaker-value plan should be marked up more than base");
  if (!(better.computed_markup_kobo < weaker.computed_markup_kobo)) {
    throw new Error("best-value plan must end up with a smaller markup than the weaker one");
  }
});

Deno.test("never adjusts markup below the configured floor", () => {
  // "better" is the far-better-value sibling here, so the density step
  // pulls its markup down hard (90% max adjustment) — without the floor
  // that would be 1200 * (1 - 0.90) = 120 kobo, well under 500.
  const rows = [
    { id: "weaker", network: "mtn", name: "50MB (X)", reseller_kobo: 100 },
    { id: "better", network: "mtn", name: "5000MB (Y)", reseller_kobo: 104 },
  ];
  const result = computeCatalogMarkup(rows, BRACKETS, {
    ...CONFIG,
    value_density_max_adjust_percent: 90,
    min_markup_floor_kobo: 500,
  });
  assertEquals(result.get("better")?.computed_markup_kobo, 500);
});

Deno.test("leaves plans with no matching bracket uncomputed rather than guessing", () => {
  const rows = [{ id: "a", network: "mtn", name: "150GB (BigBundles)", reseller_kobo: 3928000 }];
  const result = computeCatalogMarkup(rows, BRACKETS, CONFIG);
  assertEquals(result.has("a"), false);
});

Deno.test("does nothing when the engine is disabled", () => {
  const rows = [{ id: "a", network: "mtn", name: "1GB (X)", reseller_kobo: 21500 }];
  const result = computeCatalogMarkup(rows, BRACKETS, { ...CONFIG, enabled: false });
  assertEquals(result.size, 0);
});
