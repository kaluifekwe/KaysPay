import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { adminClient, enforceRateLimit, getAuthUser, isDeviceSessionAllowed, readJsonBody } from "../_shared/auth.ts";
import { isResendConfigured, sendEmail } from "../_shared/resend-client.ts";
import { pinResetNoticeEmail } from "../_shared/email-template.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders(), "Content-Type": "application/json" } });
}

serve(async (req: Request) => {
  const cors = handleCors(req); if (cors) return cors;
  const user = await getAuthUser(req);
  if (!user) return json({ success: false, error: "Unauthorized" }, 401);
  if (!user.email) return json({ success: false, error: "No verified email is available on this account." }, 400);
  const supabase = adminClient();
  if (!(await isDeviceSessionAllowed(req, supabase, user.id))) {
    return json({ success: false, error: "This device session has been revoked. Please log in again." }, 401);
  }
  const rate = await enforceRateLimit(supabase, "confirm_pin_reset", user.id, 10, 600, user.id);
  if (!rate.allowed) return json({ success: false, error: "Too many attempts. Please wait and try again." }, 429);

  let body: Record<string, unknown>;
  try { body = await readJsonBody(req, 1024); }
  catch { return json({ success: false, error: "Invalid request body" }, 400); }
  const code = String(body.code || "").trim();
  const newPin = String(body.new_pin || "");
  if (!/^\d{6}$/.test(code)) return json({ success: false, error: "Enter the 6-digit code." }, 400);
  if (!/^\d{4}$/.test(newPin)) return json({ success: false, error: "PIN must be 4 digits." }, 400);

  const { data, error } = await supabase.rpc("reset_transaction_pin_with_email_code", {
    p_user_id: user.id, p_email: user.email.toLowerCase().trim(), p_code: code, p_new_pin: newPin,
  });
  if (error) return json({ success: false, error: "Could not reset your PIN. Please try again." }, 500);
  if (!data?.success) {
    const messages: Record<string, string> = {
      NOT_FOUND: "Request a new code and try again.", EXPIRED: "This code has expired. Request a new one.",
      LOCKED: "Too many incorrect attempts. Request a new code.", INCORRECT: "Incorrect code. Please try again.",
      INVALID_PIN: "PIN must be 4 digits.",
    };
    return json({ success: false, error: messages[data?.error] || "Could not reset your PIN.", attempts_remaining: data?.attempts_remaining });
  }
  if (isResendConfigured()) {
    const notice = pinResetNoticeEmail();
    await sendEmail(user.email, notice.subject, notice.html, { text: notice.text });
  }
  return json({ success: true });
});
