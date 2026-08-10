export type FinancialMetrics = Record<string, number>;
export type FinancialAlert = {
  fingerprint: string;
  type: string;
  severity: "warning" | "critical";
  value: number;
};

export function evaluateFinancialAlerts(m: FinancialMetrics): FinancialAlert[] {
  const alerts: FinancialAlert[] = [];
  const add = (
    fingerprint: string,
    type: string,
    severity: FinancialAlert["severity"],
    value: number,
  ) => {
    if (value > 0) alerts.push({ fingerprint, type, severity, value });
  };
  add(
    "negative_wallets",
    "Wallet invariant violation",
    "critical",
    m.negative_wallets,
  );
  add(
    "duplicate_provider_refs",
    "Duplicate provider references",
    "critical",
    m.duplicate_provider_refs,
  );
  add(
    "unsafe_grants",
    "Privileged function callable without proper auth (missing anon/authenticated revoke)",
    "critical",
    m.unsafe_grants,
  );
  add("stuck_vtu", "VTU transactions stuck pending", "warning", m.stuck_vtu);
  add(
    "funding_unresolved",
    "Funding events not credited or mapped",
    "critical",
    m.funding_unresolved,
  );
  add(
    "funding_reconcile_stale",
    "Funding reconciliation has not run recently",
    "critical",
    m.funding_reconcile_stale,
  );
  add(
    "funding_reconcile_errors",
    "Funding provider reconciliation errors",
    "warning",
    m.funding_reconcile_errors,
  );
  add(
    "stuck_foreign_numbers",
    "Foreign-number transactions stuck pending",
    "warning",
    m.stuck_foreign_numbers,
  );
  add(
    "stuck_identity",
    "Identity transactions stuck beyond 72 hours",
    "warning",
    m.stuck_identity,
  );
  add(
    "burst_accounts",
    "Accounts with unusual hourly transaction velocity",
    "warning",
    m.burst_accounts,
  );
  add(
    "repeated_pin_lockouts",
    "Accounts with repeated transaction PIN lockouts",
    "warning",
    m.repeated_pin_lockouts,
  );
  add(
    "repeated_pin_resets",
    "Accounts with repeated transaction PIN resets",
    "critical",
    m.repeated_pin_resets,
  );
  add(
    "repeated_admin_denials",
    "Repeated denied admin access attempts",
    "critical",
    m.repeated_admin_denials,
  );
  add(
    "shared_device_accounts",
    "Devices associated with several customer accounts",
    "critical",
    m.shared_device_accounts,
  );
  add(
    "excessive_new_devices",
    "Accounts registering an unusual number of devices",
    "warning",
    m.excessive_new_devices,
  );
  const terminal = m.completed_24h + m.failed_24h + m.refunded_24h;
  if (terminal >= 20 && (m.failed_24h + m.refunded_24h) / terminal >= 0.2) {
    alerts.push({
      fingerprint: "high_failure_rate",
      type: "24-hour failure/refund rate above 20%",
      severity: "warning",
      value: Math.round(((m.failed_24h + m.refunded_24h) / terminal) * 100),
    });
  }
  return alerts;
}

export function metricsTableHtml(m: FinancialMetrics): string {
  const rows = Object.entries(m)
    .map(([key, value]) =>
      `<tr><td>${key.replace(/_/g, " ")}</td><td>${value}</td></tr>`
    )
    .join("");
  return `<table border="1" cellpadding="6" cellspacing="0">${rows}</table>`;
}
