import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { evaluateFinancialAlerts } from "./financial-monitor.ts";

const healthy = {
  negative_wallets: 0,
  duplicate_provider_refs: 0,
  stuck_vtu: 0,
  stuck_foreign_numbers: 0,
  stuck_identity: 0,
  burst_accounts: 0,
  completed_24h: 100,
  failed_24h: 2,
  refunded_24h: 1,
};

Deno.test("healthy financial metrics produce no alerts", () => {
  assertEquals(evaluateFinancialAlerts(healthy), []);
});

Deno.test("wallet invariant and duplicate reference findings are critical", () => {
  const alerts = evaluateFinancialAlerts({
    ...healthy,
    negative_wallets: 1,
    duplicate_provider_refs: 2,
  });
  assertEquals(alerts.map((a) => a.severity), ["critical", "critical"]);
});

Deno.test("failure rate requires sufficient sample size", () => {
  assertEquals(
    evaluateFinancialAlerts({ ...healthy, completed_24h: 5, failed_24h: 5 })
      .length,
    0,
  );
  const alerts = evaluateFinancialAlerts({
    ...healthy,
    completed_24h: 80,
    failed_24h: 20,
    refunded_24h: 0,
  });
  assertEquals(alerts.some((a) => a.fingerprint === "high_failure_rate"), true);
});
