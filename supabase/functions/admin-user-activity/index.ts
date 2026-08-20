import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { adminClient } from "../_shared/auth.ts";
import { AdminAuthError, requireAdmin } from "../_shared/admin-auth.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CATEGORIES = new Set(["account", "financial", "security", "service", "admin"]);
const OUTCOMES = new Set(["initiated", "pending", "completed", "failed", "refunded", "blocked", "recorded", "success", "failure", "attempt", "view"]);
const PAGE_SIZE = 50;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function parseDate(value: string | null): string | null | undefined {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

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

  const url = new URL(req.url);
  const subjectId = url.searchParams.get("user_id")?.trim() || "";
  const category = url.searchParams.get("category")?.trim() || null;
  const outcome = url.searchParams.get("outcome")?.trim() || null;
  const from = parseDate(url.searchParams.get("from"));
  const to = parseDate(url.searchParams.get("to"));
  const cursor = url.searchParams.get("before");
  const cursorSeparator = cursor?.lastIndexOf("|") ?? -1;
  const beforeKey = cursorSeparator > 0 ? cursor!.slice(cursorSeparator + 1) : null;
  const before = parseDate(cursorSeparator > 0 ? cursor!.slice(0, cursorSeparator) : null);

  if (!UUID_PATTERN.test(subjectId)) return json({ error: "A valid user is required" }, 400);
  if (category && !CATEGORIES.has(category)) return json({ error: "Invalid activity category" }, 400);
  if (outcome && !OUTCOMES.has(outcome)) return json({ error: "Invalid activity outcome" }, 400);
  if (from === undefined || to === undefined || before === undefined) return json({ error: "Invalid activity date" }, 400);
  if (from && to && from > to) return json({ error: "Start date must be before end date" }, 400);

  const db = adminClient();
  const { data: subject } = await db.from("customer_subjects").select("subject_id,joined_at,deleted_at").eq("subject_id", subjectId).maybeSingle();
  if (!subject) return json({ error: "Customer activity record not found" }, 404);

  const { data, error } = await db.rpc("admin_customer_activity", {
    p_subject_id: subjectId,
    p_from: from,
    p_to: to,
    p_category: category,
    p_outcome: outcome,
    p_before: before,
    p_before_key: beforeKey,
    p_limit: PAGE_SIZE + 1,
  });
  if (error) return json({ error: "Could not load customer activity" }, 500);

  const rows = data || [];
  const hasMore = rows.length > PAGE_SIZE;
  const activities = rows.slice(0, PAGE_SIZE);
  const lastActivity = activities[activities.length - 1];
  const nextCursor = hasMore && lastActivity ? `${lastActivity.occurred_at}|${lastActivity.event_key}` : null;

  const { error: auditError } = await db.from("admin_actions").insert({
    admin_user_id: admin.userId,
    action_type: "customer_activity_viewed",
    target_type: "users",
    target_id: subjectId,
    metadata: { category, outcome, from, to, page_size: activities.length },
  });
  if (auditError) return json({ error: "Activity loaded but access audit failed" }, 500);

  return json({ success: true, subject, activities, next_cursor: nextCursor });
});
