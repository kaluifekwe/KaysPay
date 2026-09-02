import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { adminClient } from "../_shared/auth.ts";
import { AdminAuthError, requireAdmin } from "../_shared/admin-auth.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";

const MAX_RANGE_MS = 366 * 86400000;
const SAFE_VERSION = /^[0-9A-Za-z._+-]{1,32}$/;
const SAFE_SOURCE = /^[A-Za-z0-9._-]{1,64}$/;
const PLATFORMS = new Set(["android", "ios", "web", "unknown"]);
const NETWORKS = new Set(["wifi", "cellular", "offline", "unknown"]);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders(), "Content-Type": "application/json" } });
}

serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);

  let admin;
  try {
    admin = await requireAdmin(req, "support");
  } catch (error) {
    if (error instanceof AdminAuthError) return json({ error: error.message }, error.status);
    return json({ error: "Unauthorized" }, 401);
  }

  const url = new URL(req.url);
  const now = new Date();
  const start = new Date(url.searchParams.get("start") || now.getTime() - 30 * 86400000);
  const end = new Date(url.searchParams.get("end") || now);
  const platform = url.searchParams.get("platform") || null;
  const appVersion = url.searchParams.get("app_version") || null;
  const country = url.searchParams.get("country")?.toUpperCase() || null;
  const network = url.searchParams.get("network") || null;
  const source = url.searchParams.get("source") || null;

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start || end.getTime() - start.getTime() > MAX_RANGE_MS) {
    return json({ error: "Invalid date range" }, 400);
  }
  if (platform && !PLATFORMS.has(platform)) return json({ error: "Invalid platform" }, 400);
  if (appVersion && !SAFE_VERSION.test(appVersion)) return json({ error: "Invalid app version" }, 400);
  if (country && !/^[A-Z]{2}$/.test(country)) return json({ error: "Invalid country" }, 400);
  if (network && !NETWORKS.has(network)) return json({ error: "Invalid network" }, 400);
  if (source && !SAFE_SOURCE.test(source)) return json({ error: "Invalid acquisition source" }, 400);

  const db = adminClient();
  const { data, error } = await db.rpc("admin_onboarding_funnel_report", {
    p_start: start.toISOString(), p_end: end.toISOString(), p_platform: platform,
    p_app_version: appVersion, p_country_code: country, p_network_type: network,
    p_acquisition_source: source,
  });
  if (error) return json({ error: "Could not load onboarding report" }, 500);

  // Lifecycle reminders (migration 197) aren't cohort-scoped -- they're a
  // live, all-time count of who's stuck right now -- so this call ignores
  // the date-range filters above and is merged into the same response.
  const { data: lifecycleReport } = await db.rpc("admin_lifecycle_reminder_report");

  const { error: auditError } = await db.from("admin_actions").insert({
    admin_user_id: admin.userId, action_type: "onboarding_report_viewed",
    target_type: "analytics", metadata: { start: start.toISOString(), end: end.toISOString(), platform, app_version: appVersion, country, network, source },
  });
  if (auditError) return json({ error: "Report loaded but access audit failed" }, 500);
  return json({ success: true, report: { ...(data as object), lifecycle_reminders: lifecycleReport ?? null } });
});

