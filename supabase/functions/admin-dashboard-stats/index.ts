import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { adminClient } from "../_shared/auth.ts";
import { AdminAuthError, requireAdmin } from "../_shared/admin-auth.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const MAX_RANGE_DAYS = 366;

serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    await requireAdmin(req, "support");
  } catch (e) {
    if (e instanceof AdminAuthError) return json({ error: e.message }, e.status);
    return json({ error: "Unauthorized" }, 401);
  }

  const url = new URL(req.url);
  const now = new Date();
  const startParam = url.searchParams.get("start");
  const endParam = url.searchParams.get("end");

  const start = startParam ? new Date(startParam) : new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const end = endParam ? new Date(endParam) : now;

  if (isNaN(start.getTime()) || isNaN(end.getTime()) || end <= start) {
    return json({ error: "Invalid date range" }, 400);
  }
  if (end.getTime() - start.getTime() > MAX_RANGE_DAYS * 24 * 60 * 60 * 1000) {
    return json({ error: `Range can't exceed ${MAX_RANGE_DAYS} days` }, 400);
  }

  const db = adminClient();
  const [report, integrity] = await Promise.all([
    db.rpc("admin_dashboard_report", { p_start: start.toISOString(), p_end: end.toISOString() }),
    db.rpc("collect_financial_integrity_metrics"),
  ]);

  if (report.error || integrity.error) {
    return json({ error: "Could not load dashboard stats" }, 500);
  }

  return json({ success: true, report: report.data, integrity: integrity.data });
});
