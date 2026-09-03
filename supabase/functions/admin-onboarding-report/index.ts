import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { adminClient, readJsonBody, RequestBodyError } from "../_shared/auth.ts";
import { AdminAuthError, requireAdmin } from "../_shared/admin-auth.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { isResendConfigured, sendEmail } from "../_shared/resend-client.ts";
import { fundedNotPurchasedReminderEmail, kycReminderEmail, kycVerifiedNotFundedReminderEmail, pinNotSetReminderEmail } from "../_shared/email-template.ts";

const WELCOME_FROM = "Kalu Ifekwe <no-reply@kayspay.com.ng>";
const WELCOME_REPLY_TO = "kaluifekwe6@gmail.com";
const LIFECYCLE_STAGES = new Set(["pin_not_set", "kyc_not_started", "kyc_completed_not_funded", "funded_not_purchased"]);

function firstNameOf(fullName: string | null): string {
  if (!fullName) return "";
  return fullName.trim().split(/\s+/)[0] || "";
}
function templateFor(stage: string) {
  if (stage === "pin_not_set") return pinNotSetReminderEmail;
  if (stage === "kyc_not_started") return kycReminderEmail;
  if (stage === "kyc_completed_not_funded") return kycVerifiedNotFundedReminderEmail;
  return fundedNotPurchasedReminderEmail;
}

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

  if (req.method === "POST") {
    let admin;
    try {
      admin = await requireAdmin(req, "super_admin");
    } catch (error) {
      if (error instanceof AdminAuthError) return json({ error: error.message }, error.status);
      return json({ error: "Unauthorized" }, 401);
    }

    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req, 2048);
    } catch (error) {
      const e = error instanceof RequestBodyError ? error : new RequestBodyError(400, "Invalid request body");
      return json({ error: e.message }, e.status);
    }

    if (body.action !== "send_followup") return json({ error: "Unknown action" }, 400);
    const userId = String(body.user_id || "");
    const stage = String(body.stage || "");
    if (!/^[0-9a-f-]{36}$/i.test(userId)) return json({ error: "Invalid user_id" }, 400);
    if (!LIFECYCLE_STAGES.has(stage)) return json({ error: "Invalid stage" }, 400);
    if (!isResendConfigured()) return json({ error: "Email service not configured" }, 500);

    const db = adminClient();
    const { data: claimed, error: claimError } = await db.rpc("admin_send_manual_lifecycle_reminder", {
      p_user_id: userId, p_stage: stage,
    });
    if (claimError) return json({ error: "Could not claim this follow-up" }, 500);
    const row = (claimed || [])[0] as { id: string; email: string; full_name: string | null; attempt_number: number } | undefined;
    if (!row) return json({ error: "This customer is no longer eligible -- they may have already resolved, or are suppressed." }, 409);

    const template = templateFor(stage);
    const { subject, html, text } = template(firstNameOf(row.full_name));
    const result = await sendEmail(row.email, subject, html, { from: WELCOME_FROM, replyTo: WELCOME_REPLY_TO, text });
    if (!result.ok) {
      await db.from("lifecycle_reminders").delete().eq("id", row.id);
      return json({ error: "Send failed: " + (result.error || "unknown error") }, 500);
    }
    if (result.id) await db.rpc("mark_lifecycle_reminder_sent", { p_id: row.id, p_provider_message_id: result.id });

    await db.from("admin_actions").insert({
      admin_user_id: admin.userId, action_type: "lifecycle_reminder_manual_send",
      target_type: "user", target_id: userId,
      metadata: { stage, attempt_number: row.attempt_number },
    });
    return json({ success: true, attempt_number: row.attempt_number });
  }

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
  const { data: followupCandidates } = await db.rpc("admin_list_lifecycle_followup_candidates");

  const { error: auditError } = await db.from("admin_actions").insert({
    admin_user_id: admin.userId, action_type: "onboarding_report_viewed",
    target_type: "analytics", metadata: { start: start.toISOString(), end: end.toISOString(), platform, app_version: appVersion, country, network, source },
  });
  if (auditError) return json({ error: "Report loaded but access audit failed" }, 500);
  const lifecycleWithFollowups = lifecycleReport ? { ...lifecycleReport, followup_candidates: followupCandidates ?? [] } : null;
  return json({ success: true, report: { ...(data as object), lifecycle_reminders: lifecycleWithFollowups } });
});

