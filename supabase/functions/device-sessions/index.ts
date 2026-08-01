import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  adminClient,
  enforceRateLimit,
  getAuthUser,
  getSessionId,
  readJsonBody,
  RequestBodyError,
} from "../_shared/auth.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { isResendConfigured, sendEmail } from "../_shared/resend-client.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  const user = await getAuthUser(req);
  if (!user) return json({ error: "Unauthorized" }, 401);
  const sid = getSessionId(req);
  if (!sid) return json({ error: "Invalid session" }, 401);
  const db = adminClient();
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req, 4096);
  } catch (error) {
    const e = error instanceof RequestBodyError
      ? error
      : new RequestBodyError(400, "Invalid request body");
    return json({ error: e.message }, e.status);
  }
  const action = String(body.action || "");
  if (action === "register") {
    const { data, error } = await db.rpc("register_device_session", {
      p_user_id: user.id,
      p_session_id: sid,
      p_device_id: String(body.device_id || ""),
      p_device_name: String(body.device_name || "Unknown device"),
      p_platform: String(body.platform || "unknown"),
    });
    if (error) return json({ error: "Could not register device" }, 500);
    if (data?.is_new_device && user.email && isResendConfigured()) {
      const name = String(body.device_name || "Unknown device").replace(
        /[<>&]/g,
        "",
      );
      await sendEmail(
        user.email,
        "New device signed in to Kay's Pay",
        `<p>A new device signed in to your Kay's Pay account:</p><p><b>${name}</b></p><p>If this wasn't you, reset your password and revoke other devices in Settings.</p>`,
        {
          text:
            `A new device signed in: ${name}. If this wasn't you, reset your password and revoke other devices.`,
        },
      );
    }
    return json({ success: true, is_new_device: data?.is_new_device === true });
  }
  if (action === "list") {
    const { data, error } = await db.rpc("list_device_sessions", {
      p_user_id: user.id,
    });
    if (error) return json({ error: "Could not load sessions" }, 500);
    return json({
      success: true,
      sessions: (data || []).map((d: Record<string, unknown>) => {
        const { internal_session_id, ...safe } = d;
        return { ...safe, is_current: internal_session_id === sid };
      }),
    });
  }
  if (action === "revoke") {
    const { data, error } = await db.rpc("revoke_device_session", {
      p_user_id: user.id,
      p_device_session_id: String(body.id || ""),
      p_current_session_id: sid,
    });
    return error
      ? json({ error: "Could not revoke session" }, 500)
      : json({ success: data === true });
  }
  if (action === "revoke_others") {
    const { data, error } = await db.rpc("revoke_other_device_sessions", {
      p_user_id: user.id,
      p_current_session_id: sid,
    });
    return error
      ? json({ error: "Could not revoke sessions" }, 500)
      : json({ success: true, count: Number(data || 0) });
  }
  if (action === "check") {
    const { data } = await db.rpc("is_device_session_revoked", {
      p_user_id: user.id,
      p_session_id: sid,
    });
    return data === true
      ? json({ revoked: true }, 401)
      : json({ revoked: false });
  }
  if (action === "pin_changed") {
    const rate = await enforceRateLimit(
      db,
      "pin_change_notice",
      user.id,
      3,
      86400,
      user.id,
    );
    if (rate.allowed && user.email && isResendConfigured()) {
      await sendEmail(
        user.email,
        "Your Kay's Pay PIN was changed",
        "<p>Your transaction PIN was changed successfully.</p><p>If this wasn't you, reset your password and remove other devices immediately.</p>",
        {
          text:
            "Your Kay's Pay transaction PIN was changed. If this wasn't you, reset your password and remove other devices immediately.",
        },
      );
    }
    await db.from("security_events").insert({
      user_id: user.id,
      event_type: "pin_changed",
      severity: "warning",
      source: "device-sessions",
      metadata: {},
    });
    return json({ success: true });
  }
  return json({ error: "Invalid action" }, 400);
});
