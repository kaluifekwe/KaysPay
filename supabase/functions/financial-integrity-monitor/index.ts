import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { adminClient, verifyCronSecret, withJobLock } from "../_shared/auth.ts";
import { isResendConfigured, sendEmail } from "../_shared/resend-client.ts";
import { redactSecrets } from "../_shared/redact.ts";
import {
  evaluateFinancialAlerts,
  FinancialMetrics,
  metricsTableHtml,
} from "../_shared/financial-monitor.ts";

const ALERT_EMAIL = Deno.env.get("SECURITY_ALERT_EMAIL") ||
  "kaluifekwe6@gmail.com";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  if (!verifyCronSecret(req)) return json({ error: "Unauthorized" }, 401);
  const db = adminClient();
  try {
    const result = await withJobLock(
      db,
      "financial-integrity-monitor",
      async () => {
        const { data, error } = await db.rpc(
          "collect_financial_integrity_metrics",
        );
        if (error || !data) throw error || new Error("No metrics returned");
        const metrics = Object.fromEntries(
          Object.entries(data as Record<string, unknown>).map((
            [k, v],
          ) => [k, Number(v || 0)]),
        ) as FinancialMetrics;
        await db.rpc("record_monitoring_run", { p_metrics: metrics });

        let emailed = 0;
        for (const alert of evaluateFinancialAlerts(metrics)) {
          const { data: shouldEmail } = await db.rpc(
            "record_monitoring_alert",
            {
              p_fingerprint: alert.fingerprint,
              p_type: alert.type,
              p_severity: alert.severity,
              p_details: { value: alert.value },
            },
          );
          if (shouldEmail && isResendConfigured()) {
            const sent = await sendEmail(
              ALERT_EMAIL,
              `[${alert.severity.toUpperCase()}] Kay's Pay: ${alert.type}`,
              `<p>${alert.type}: <b>${alert.value}</b></p><p>No balances or transactions were changed by this monitor.</p>`,
            );
            if (sent.ok) emailed++;
          }
        }

        // 07:00 WAT daily. The unique report_date claim prevents duplicates.
        const now = new Date();
        if (now.getUTCHours() === 6) {
          const watDate = new Date(now.getTime() + 60 * 60 * 1000).toISOString()
            .slice(0, 10);
          const { data: claimed } = await db.rpc(
            "claim_daily_monitoring_report",
            { p_date: watDate, p_metrics: metrics },
          );
          if (claimed && isResendConfigured()) {
            await sendEmail(
              ALERT_EMAIL,
              `Kay's Pay daily operations summary — ${watDate}`,
              `<p>Automated read-only summary for the last 24 hours.</p>${
                metricsTableHtml(metrics)
              }`,
            );
          }
        }
        return {
          checked: true,
          alerts: evaluateFinancialAlerts(metrics).length,
          emailed,
        };
      },
    );
    return json(result);
  } catch (error) {
    console.error("financial-integrity-monitor failed:", redactSecrets(error));
    return json({ checked: false, error: "Monitoring run failed" }, 500);
  }
});
