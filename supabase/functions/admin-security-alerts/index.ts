import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { adminClient, readJsonBody, RequestBodyError } from "../_shared/auth.ts";
import { AdminAuthError, requireAdmin } from "../_shared/admin-auth.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
  });
}

const VALID_STATUSES = ["open", "acknowledged", "resolved"] as const;
const VALID_ACTIONS = ["acknowledge", "resolve", "reopen"] as const;
const VALID_RESPONSE_ACTIONS = ["restrict_financial", "lift_restriction", "revoke_sessions"] as const;
const VALID_APPROVAL_ACTIONS = ["approve_override", "reject_override"] as const;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  let admin;
  try {
    admin = await requireAdmin(req, "support");
  } catch (error) {
    if (error instanceof AdminAuthError) return json({ error: error.message }, error.status);
    return json({ error: "Unauthorized" }, 401);
  }

  const db = adminClient();

  if (req.method === "GET") {
    const url = new URL(req.url);
    const status = url.searchParams.get("status") || "open";
    const severity = url.searchParams.get("severity") || "";
    const page = Math.max(Number(url.searchParams.get("page") || 1), 1);
    const pageSize = 30;
    if (status !== "all" && !VALID_STATUSES.includes(status as typeof VALID_STATUSES[number])) {
      return json({ error: "Invalid status" }, 400);
    }
    if (severity && !["warning", "critical"].includes(severity)) {
      return json({ error: "Invalid severity" }, 400);
    }

    let query = db.from("monitoring_alerts")
      .select("fingerprint,alert_type,severity,details,occurrence_count,first_seen_at,last_seen_at,last_alerted_at,status,acknowledged_at,resolved_at,resolution_notes,updated_at", { count: "exact" })
      .order("last_seen_at", { ascending: false })
      .range((page - 1) * pageSize, page * pageSize - 1);
    if (status !== "all") query = query.eq("status", status);
    if (severity) query = query.eq("severity", severity);

    const [alertsResult, runResult, eventsResult, statusResult, healthResult, casesResult, restrictionsResult, approvalsResult] = await Promise.all([
      query,
      db.from("monitoring_runs").select("id,created_at,metrics").order("created_at", { ascending: false }).limit(1).maybeSingle(),
      db.from("security_events").select("id,user_id,event_type,severity,source,metadata,created_at").order("created_at", { ascending: false }).limit(50),
      db.from("monitoring_alerts").select("status"),
      db.from("monitoring_health").select("last_success_at,last_failure_at,last_email_at,consecutive_failures,last_error_code").eq("singleton", true).maybeSingle(),
      db.from("security_cases").select("id,user_id,severity,status,summary,created_by,assigned_to,created_at,resolved_at,resolved_by,resolution_notes").order("created_at", { ascending: false }).limit(100),
      db.from("financial_restrictions").select("id,case_id,user_id,status,reason,imposed_by,imposed_at,lifted_by,lifted_at,lift_reason,reverification_method").order("imposed_at", { ascending: false }).limit(100),
      db.from("security_override_approvals").select("id,restriction_id,case_id,user_id,status,request_reason,requested_by,requested_at,decided_by,decided_at,decision_notes").order("requested_at", { ascending: false }).limit(100),
    ]);

    if (alertsResult.error || runResult.error || eventsResult.error || statusResult.error || healthResult.error || casesResult.error || restrictionsResult.error || approvalsResult.error) {
      return json({ error: "Could not load security operations" }, 500);
    }
    const latestRun = runResult.data;
    const lastSuccessAt = healthResult.data?.last_success_at || latestRun?.created_at || null;
    const ageMs = lastSuccessAt ? Date.now() - new Date(lastSuccessAt).getTime() : Number.POSITIVE_INFINITY;
    const statusCounts = { open: 0, acknowledged: 0, resolved: 0 };
    for (const item of statusResult.data || []) {
      if (item.status in statusCounts) statusCounts[item.status as keyof typeof statusCounts]++;
    }

    // device_hash is useful for server-side correlation but should not be
    // rendered or returned to a browser administrator.
    const events = (eventsResult.data || []).map((event) => {
      const metadata = { ...((event.metadata || {}) as Record<string, unknown>) };
      delete metadata.device_hash;
      return { ...event, metadata };
    });

    return json({
      success: true,
      alerts: alertsResult.data || [],
      total: alertsResult.count || 0,
      page,
      page_size: pageSize,
      status_counts: statusCounts,
      monitor: {
        healthy: ageMs <= 20 * 60 * 1000,
        last_success_at: lastSuccessAt,
        last_failure_at: healthResult.data?.last_failure_at ?? null,
        last_email_at: healthResult.data?.last_email_at ?? null,
        consecutive_failures: healthResult.data?.consecutive_failures ?? 0,
        last_error_code: healthResult.data?.last_error_code ?? null,
        age_seconds: Number.isFinite(ageMs) ? Math.max(Math.floor(ageMs / 1000), 0) : null,
        metrics: latestRun?.metrics ?? {},
      },
      recent_events: events,
      security_cases: casesResult.data || [],
      financial_restrictions: restrictionsResult.data || [],
      override_approvals: approvalsResult.data || [],
    });
  }

  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req, 2048);
  } catch (error) {
    const e = error instanceof RequestBodyError ? error : new RequestBodyError(400, "Invalid request body");
    return json({ error: e.message }, e.status);
  }

  const fingerprint = String(body.fingerprint || "");
  const action = String(body.action || "");
  const notes = String(body.notes || "").trim();
  if (VALID_APPROVAL_ACTIONS.includes(action as typeof VALID_APPROVAL_ACTIONS[number])) {
    if (admin.role !== "super_admin") return json({ error: "Super admin approval is required" }, 403);
    const approvalId = String(body.approval_id || "");
    if (!UUID_PATTERN.test(approvalId)) return json({ error: "A valid approval request is required" }, 400);
    if (notes.length < 5 || notes.length > 500) return json({ error: "Decision notes must be 5 to 500 characters" }, 400);
    const { data, error } = await db.rpc("admin_decide_restriction_override", {
      p_admin_user_id: admin.userId,
      p_approval_id: approvalId,
      p_approve: action === "approve_override",
      p_notes: notes,
    });
    if (error) {
      if (error.message.includes("SELF_APPROVAL_FORBIDDEN")) return json({ error: "The administrator who requested this override cannot approve it" }, 409);
      return json({ error: "Could not record the override decision" }, 400);
    }
    return json({ success: true, result: data });
  }

  if (VALID_RESPONSE_ACTIONS.includes(action as typeof VALID_RESPONSE_ACTIONS[number])) {
    if (admin.role !== "super_admin") return json({ error: "Super admin approval is required" }, 403);
    const userId = String(body.user_id || "");
    const summary = String(body.summary || "").trim();
    if (!UUID_PATTERN.test(userId)) return json({ error: "A valid user reference is required" }, 400);
    if (summary.length < 5 || summary.length > 200) return json({ error: "Summary must be 5 to 200 characters" }, 400);
    if (notes.length < 5 || notes.length > 500) return json({ error: "Reason must be 5 to 500 characters" }, 400);
    if ((action === "restrict_financial" || body.override === true) && notes.length < 10) {
      return json({ error: "Restriction and override reasons must be at least 10 characters" }, 400);
    }

    let result;
    if (action === "restrict_financial") {
      const { data, error } = await db.rpc("admin_apply_financial_restriction", {
        p_admin_user_id: admin.userId,
        p_user_id: userId,
        p_summary: summary,
        p_reason: notes,
        p_severity: body.severity === "warning" ? "warning" : "critical",
      });
      if (error) return json({ error: error.message.includes("ACCOUNT_ALREADY_RESTRICTED") ? "This account is already restricted" : "Could not apply restriction" }, 400);
      result = data;
    } else if (action === "revoke_sessions") {
      const { data, error } = await db.rpc("admin_revoke_user_sessions", {
        p_admin_user_id: admin.userId,
        p_user_id: userId,
        p_summary: summary,
        p_reason: notes,
      });
      if (error) return json({ error: "Could not revoke sessions" }, 400);
      result = data;
    } else {
      const restrictionId = String(body.restriction_id || "");
      if (!UUID_PATTERN.test(restrictionId)) return json({ error: "A valid restriction is required" }, 400);
      if (body.override === true) {
        const { data, error } = await db.rpc("admin_request_restriction_override", {
          p_admin_user_id: admin.userId,
          p_restriction_id: restrictionId,
          p_reason: notes,
        });
        if (error) {
          if (error.message.includes("SECOND_SUPER_ADMIN_REQUIRED")) return json({ error: "Add a second active super admin before requesting an emergency override" }, 409);
          if (error.message.includes("idx_one_pending_security_override") || error.message.includes("duplicate key")) return json({ error: "An override request is already pending" }, 409);
          return json({ error: "Could not request emergency override" }, 400);
        }
        result = data;
      } else {
        const { data, error } = await db.rpc("admin_lift_financial_restriction", {
          p_admin_user_id: admin.userId,
          p_restriction_id: restrictionId,
          p_reason: notes,
          p_override: false,
        });
        if (error) return json({ error: "Could not remove restriction" }, 400);
        if (data?.success === false && data?.error === "REVERIFICATION_REQUIRED") {
          return json({ error: "The customer must reset their transaction PIN using verified email before this restriction can be removed." }, 409);
        }
        result = data;
      }
    }

    return json({ success: true, result });
  }

  if (!/^[a-z0-9_-]{3,100}$/.test(fingerprint)) return json({ error: "Invalid alert" }, 400);
  if (!VALID_ACTIONS.includes(action as typeof VALID_ACTIONS[number])) return json({ error: "Invalid action" }, 400);
  if (notes.length > 500) return json({ error: "Notes must be 500 characters or fewer" }, 400);
  if (action === "resolve" && notes.length < 3) return json({ error: "Resolution notes are required" }, 400);

  const now = new Date().toISOString();
  const changes = action === "acknowledge"
    ? { status: "acknowledged", acknowledged_at: now, acknowledged_by: admin.userId, updated_at: now }
    : action === "resolve"
    ? { status: "resolved", resolved_at: now, resolved_by: admin.userId, resolution_notes: notes, updated_at: now }
    : {
      status: "open", acknowledged_at: null, acknowledged_by: null,
      resolved_at: null, resolved_by: null, resolution_notes: null, updated_at: now,
    };

  const { data: alert, error } = await db.from("monitoring_alerts")
    .update(changes)
    .eq("fingerprint", fingerprint)
    .select("fingerprint,status,updated_at")
    .maybeSingle();
  if (error) return json({ error: "Could not update alert" }, 500);
  if (!alert) return json({ error: "Alert not found" }, 404);

  const actionPastTense = action === "acknowledge" ? "acknowledged" : action === "resolve" ? "resolved" : "reopened";
  const { error: auditError } = await db.from("admin_actions").insert({
    admin_user_id: admin.userId,
    action_type: `security_alert_${actionPastTense}`,
    target_type: "monitoring_alerts",
    target_id: fingerprint,
    reason: notes || null,
    metadata: { resulting_status: alert.status },
  });
  if (auditError) return json({ error: "Alert updated but audit record failed" }, 500);
  return json({ success: true, alert });
});
