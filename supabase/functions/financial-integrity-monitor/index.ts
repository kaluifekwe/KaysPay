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

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function stuckVtuDetails(db: ReturnType<typeof adminClient>): Promise<string> {
  const cutoff = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  const { data, error } = await db
    .from("transactions")
    .select("id, type, created_at, metadata")
    .eq("status", "pending")
    .in("type", ["airtime", "data", "bill", "exam_pin"])
    .lt("created_at", cutoff)
    .order("created_at", { ascending: true })
    .limit(20);
  if (error || !data?.length) return "";

  const rows = data.map((tx) => {
    const metadata = tx.metadata as Record<string, unknown> | null;
    const reference = metadata?.provider_transaction_id ?? metadata?.provider_reference ?? tx.id;
    const ageMinutes = Math.max(0, Math.floor((Date.now() - new Date(tx.created_at).getTime()) / 60_000));
    return `<tr><td>${escapeHtml(reference)}</td><td>${escapeHtml(tx.type)}</td><td>${escapeHtml(metadata?.provider ?? "unknown")}</td><td>${ageMinutes} min</td></tr>`;
  }).join("");
  return `<table border="1" cellpadding="6" cellspacing="0"><tr><th>Reference</th><th>Service</th><th>Provider</th><th>Age</th></tr>${rows}</table>`;
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
            const details = alert.fingerprint === "stuck_vtu" ? await stuckVtuDetails(db) : "";
            const sent = await sendEmail(
              ALERT_EMAIL,
              `[${alert.severity.toUpperCase()}] Kay's Pay: ${alert.type}`,
              `<p>${alert.type}: <b>${alert.value}</b></p>${details}<p>No balances or transactions were changed by this monitor.</p>`,
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
            const dailySent = await sendEmail(
              ALERT_EMAIL,
              `Kay's Pay daily operations summary — ${watDate}`,
              `<p>Automated read-only summary for the last 24 hours.</p>${
                metricsTableHtml(metrics)
              }`,
            );
            if (dailySent.ok) emailed++;
          }
        }
        return {
          checked: true,
          alerts: evaluateFinancialAlerts(metrics).length,
          emailed,
        };
      },
    );
    await db.rpc("record_monitoring_health", {
      p_success: true,
      p_email_sent: "emailed" in result && result.emailed > 0,
      p_error_code: null,
    });
    return json(result);
  } catch (error) {
    console.error("financial-integrity-monitor failed:", redactSecrets(error));
    await db.rpc("record_monitoring_health", {
      p_success: false,
      p_email_sent: false,
      p_error_code: "MONITOR_RUN_FAILED",
    });
    return json({ checked: false, error: "Monitoring run failed" }, 500);
  }
});
