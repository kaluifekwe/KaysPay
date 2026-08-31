import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  computeCatalogMarkup, parseDataSizeToMb, parseValidityDays, validityAdjustmentKobo,
} from "./data-markup-engine.ts";

const BRACKETS = [
  { min_price_kobo: 0, max_price_kobo: 50000, markup_type: "percent" as const, markup_value: 800, min_markup_kobo: 3000, min_net_margin_kobo: 2500 },
  { min_price_kobo: 50000, max_price_kobo: 150000, markup_type: "percent" as const, markup_value: 600, min_markup_kobo: 5000, min_net_margin_kobo: 4500 },
  { min_price_kobo: 150000, max_price_kobo: 300000, markup_type: "percent" as const, markup_value: 500, min_markup_kobo: 10000, min_net_margin_kobo: 9000 },
  { min_price_kobo: 300000, max_price_kobo: 750000, markup_type: "percent" as const, markup_value: 500, min_markup_kobo: 15000, min_net_margin_kobo: 13500 },
];

const CONFIG = {
  enabled: true,
  value_density_enabled: true,
  value_density_max_adjust_percent: 30,
  value_density_price_window_percent: 10,
  min_markup_floor_kobo: 100,
  discount_percent_of_markup: 0,
  cashback_percent_of_markup: 10,
};

Deno.test("parseDataSizeToMb reads GB and MB tokens", () => {
  assertEquals(parseDataSizeToMb("1GB (AwoofData)"), 1024);
  assertEquals(parseDataSizeToMb("500MB (DataShare4)"), 500);
  assertEquals(parseDataSizeToMb("16.5GB+10mins (GiftingPlan)"), 16.5 * 1024);
  assertEquals(parseDataSizeToMb("Do Not Buy MTN AwoofData"), null);
});

Deno.test("normalizes validity and applies only capped premiums", () => {
  assertEquals(parseValidityDays("7 Days"), 7);
  assertEquals(parseValidityDays("2 weeks"), 14);
  assertEquals(parseValidityDays("1 Month"), 30);
  assertEquals(validityAdjustmentKobo(7), 0);
  assertEquals(validityAdjustmentKobo(14), 500);
  assertEquals(validityAdjustmentKobo(30), 1000);
  assertEquals(validityAdjustmentKobo(90), 2000);
});

Deno.test("same 1GB plan gets a small capped premium for longer validity", () => {
  const rows = [
    { id: "weekly", network: "mtn", name: "1GB", validity: "7 Days", family_key: "gifting", reseller_kobo: 50000 },
    { id: "monthly", network: "mtn", name: "1GB", validity: "30 Days", family_key: "gifting", reseller_kobo: 50000 },
  ];
  const result = computeCatalogMarkup(rows, BRACKETS, CONFIG);
  assertEquals(result.get("monthly")!.computed_price_kobo - result.get("weekly")!.computed_price_kobo, 1000);
  assertEquals(result.get("weekly")!.validity_adjustment_kobo, 0);
  assertEquals(result.get("monthly")!.validity_adjustment_kobo, 1000);
  assertEquals(result.get("monthly")!.pricing_engine_version, 2);
});

Deno.test("flags a strictly dominated plan inside the same network and family", () => {
  const rows = [
    { id: "worse", network: "mtn", name: "1GB", validity: "7 Days", family_key: "gifting", reseller_kobo: 60000 },
    { id: "better", network: "mtn", name: "2GB", validity: "30 Days", family_key: "gifting", reseller_kobo: 50000 },
  ];
  const result = computeCatalogMarkup(rows, BRACKETS, CONFIG);
  assertEquals(result.get("worse")!.requires_pricing_review, true);
  assertEquals(result.get("better")!.requires_pricing_review, false);
});

Deno.test("applies the matching bracket's gross floor", () => {
  const rows = [{ id: "a", network: "mtn", name: "1GB (AwoofData)", reseller_kobo: 21500 }];
  const result = computeCatalogMarkup(rows, BRACKETS, { ...CONFIG, value_density_enabled: false });
  const plan = result.get("a")!;
  assertEquals(plan.computed_markup_kobo, 3000);
  assertEquals(plan.computed_list_price_kobo, 24500);
  assertEquals(plan.computed_discount_kobo, 0);
  assertEquals(plan.computed_price_kobo, 24500);
  assertEquals(plan.computed_cashback_kobo, 300);
});

Deno.test("never quotes or charges a fractional-naira price", () => {
  const rows = [{ id: "a", network: "mtn", name: "2GB (AwoofData)", reseller_kobo: 42000 }];
  const result = computeCatalogMarkup(rows, BRACKETS, { ...CONFIG, value_density_enabled: false });
  const plan = result.get("a")!;
  assertEquals(plan.computed_list_price_kobo % 100, 0);
  assertEquals(plan.computed_price_kobo % 100, 0);
  assertEquals(plan.computed_discount_kobo % 100, 0);
  assertEquals(plan.computed_cashback_kobo % 100, 0);
  // Rounds UP to the next whole naira, never down — keeps the charged price
  // from ever dipping below list price minus the true discount.
  assertEquals(plan.computed_list_price_kobo, 45400);
  assertEquals(plan.computed_price_kobo, 45400);
  assertEquals(plan.computed_discount_kobo, 0);
  // "was" minus "now" always exactly equals the discount shown, since
  // discount is derived from the two already-rounded numbers.
  assertEquals(plan.computed_list_price_kobo - plan.computed_price_kobo, plan.computed_discount_kobo);
});

Deno.test("rejects a configuration that leaves no room for the net floor", () => {
  const rows = [{ id: "a", network: "mtn", name: "1GB (AwoofData)", reseller_kobo: 21500 }];
  const result = computeCatalogMarkup(rows, BRACKETS, {
    ...CONFIG, value_density_enabled: false, discount_percent_of_markup: 100,
  });
  assertEquals(result.has("a"), false);
});

Deno.test("applies percentage brackets on the provider price", () => {
  const rows = [{ id: "a", network: "mtn", name: "3GB (DataShare)", reseller_kobo: 112000 }];
  const result = computeCatalogMarkup(rows, BRACKETS, { ...CONFIG, value_density_enabled: false });
  // 6% of 112000 = 6720, above the N50 floor.
  assertEquals(result.get("a")?.computed_markup_kobo, 6720);
});

Deno.test("data volume never reduces margin between same-price plans", () => {
  const rows = [
    { id: "better", network: "mtn", name: "200MB (Social Media Data)", reseller_kobo: 9740 },
    { id: "weaker", network: "mtn", name: "110MB (GiftingPlan)", reseller_kobo: 9740 },
  ];
  const result = computeCatalogMarkup(rows, BRACKETS, CONFIG);
  const better = result.get("better")!;
  const weaker = result.get("weaker")!;
  assertEquals(better.computed_markup_kobo, 3000);
  assertEquals(weaker.computed_markup_kobo, 3000);
});

Deno.test("N3,000 provider cost keeps at least N135 after 10% cashback", () => {
  const rows = [{ id: "a", network: "mtn", name: "3GB", reseller_kobo: 300000 }];
  const plan = computeCatalogMarkup(rows, BRACKETS, CONFIG).get("a")!;
  assertEquals(plan.computed_markup_kobo, 15000);
  assertEquals(plan.computed_cashback_kobo, 1500);
  assertEquals(plan.computed_markup_kobo - plan.computed_cashback_kobo, 13500);
});

Deno.test("universal discount and cashback preserve the configured net floor", () => {
  const rows = [{ id: "a", network: "mtn", name: "3GB", validity: "7 Days", reseller_kobo: 300000 }];
  const plan = computeCatalogMarkup(rows, BRACKETS, {
    ...CONFIG,
    value_density_enabled: false,
    discount_percent_of_markup: 20,
    cashback_percent_of_markup: 10,
  }).get("a")!;

  assertEquals(plan.computed_markup_kobo, 19486);
  assertEquals(plan.computed_list_price_kobo, 319500);
  assertEquals(plan.computed_discount_kobo, 3900);
  assertEquals(plan.computed_price_kobo, 315600);
  assertEquals(plan.computed_cashback_kobo, 1900);
  assertEquals(
    plan.computed_markup_kobo - plan.computed_discount_kobo - plan.computed_cashback_kobo >= 13500,
    true,
  );
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
