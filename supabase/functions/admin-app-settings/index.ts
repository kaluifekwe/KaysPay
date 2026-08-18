import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { adminClient, readJsonBody, RequestBodyError } from "../_shared/auth.ts";
import { AdminAuthError, requireAdmin } from "../_shared/admin-auth.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";

// Owner-editable app settings (see migration 131). Currently just the
// support WhatsApp number, which the mobile app used to hardcode in three
// places. Same shape as admin-service-controls: GET for any admin,
// POST restricted to super_admin, every write audited in admin_actions.
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const VALID_KEYS = ["support_whatsapp_number"];

/**
 * Normalises a WhatsApp number to the digits-only international form
 * wa.me needs — strips +, spaces, dashes and brackets, so the owner can
 * paste "+234 906 844 6111" or "234-906-844-6111" and it just works.
 * A local 0-prefixed Nigerian number (0906...) is converted to 234906...
 * since wa.me will not resolve a national-format number.
 */
function normaliseWhatsAppNumber(raw: string): string | null {
  let digits = raw.replace(/[^\d]/g, "");
  if (digits.startsWith("0") && digits.length === 11) {
    digits = "234" + digits.slice(1);
  }
  // Loose bound rather than Nigeria-only: support could legitimately move to
  // another country's number, and wa.me accepts any valid E.164 subscriber
  // number. Anything outside this range is a typo, not a real number.
  if (digits.length < 10 || digits.length > 15) return null;
  return digits;
}

serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method === "GET") {
    try {
      await requireAdmin(req, "support");
    } catch (e) {
      if (e instanceof AdminAuthError) return json({ error: e.message }, e.status);
      return json({ error: "Unauthorized" }, 401);
    }
    const db = adminClient();
    const { data, error } = await db
      .from("app_settings")
      .select("key, value, updated_at")
      .order("key");
    if (error) return json({ error: "Could not load app settings" }, 500);
    return json({ success: true, settings: data });
  }

  if (req.method === "POST") {
    let admin;
    try {
      admin = await requireAdmin(req, "super_admin");
    } catch (e) {
      if (e instanceof AdminAuthError) return json({ error: e.message }, e.status);
      return json({ error: "Unauthorized" }, 401);
    }

    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req, 2048);
    } catch (error) {
      const e = error instanceof RequestBodyError ? error : new RequestBodyError(400, "Invalid request body");
      return json({ error: e.message }, e.status);
    }

    const key = String(body.key || "");
    if (!VALID_KEYS.includes(key)) {
      return json({ error: "Invalid setting" }, 400);
    }

    const rawValue = String(body.value ?? "").trim();
    let value: string;
    if (key === "support_whatsapp_number") {
      const normalised = normaliseWhatsAppNumber(rawValue);
      if (!normalised) {
        return json({
          error: "Enter a valid WhatsApp number in international format, e.g. 2349068446111.",
        }, 400);
      }
      value = normalised;
    } else {
      if (!rawValue) return json({ error: "A value is required" }, 400);
      value = rawValue;
    }

    const db = adminClient();
    const { error } = await db
      .from("app_settings")
      .update({ value, updated_at: new Date().toISOString() })
      .eq("key", key);
    if (error) return json({ error: "Could not update the setting" }, 500);

    await db.from("admin_actions").insert({
      admin_user_id: admin.userId,
      action_type: "app_setting_update",
      target_type: "app_settings",
      target_id: key,
      reason: null,
      metadata: { value },
    });

    const { data: updated, error: readError } = await db
      .from("app_settings")
      .select("key, value, updated_at")
      .eq("key", key)
      .single();
    if (readError) return json({ error: "Saved, but the latest value could not be loaded" }, 500);
    return json({ success: true, setting: updated });
  }

  return json({ error: "Method not allowed" }, 405);
});
