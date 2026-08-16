import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { adminClient, enforceRateLimit, getAuthUser, isDeviceSessionAllowed } from "../_shared/auth.ts";
import { isResendConfigured, sendEmail } from "../_shared/resend-client.ts";
import { pinResetEmail } from "../_shared/email-template.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
function generateCode(): string {
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return String(bytes[0] % 1_000_000).padStart(6, "0");
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
  const rate = await enforceRateLimit(supabase, "request_pin_reset", user.id, 5, 3600, user.id);
  if (!rate.allowed) return json({ success: false, error: "Too many reset requests. Please wait and try again." }, 429);
  if (!isResendConfigured()) return json({ success: false, error: "Email service is unavailable right now." }, 503);

  const code = generateCode();
  const email = user.email.toLowerCase().trim();
  const { data, error } = await supabase.rpc("create_email_verification_code", {
    p_user_id: user.id, p_purpose: "pin_reset", p_target: email, p_code: code,
  });
  if (error || !data?.ok) {
    const message = data?.error === "RATE_LIMITED"
      ? "Please wait before requesting another code."
      : data?.error === "DAILY_LIMIT_REACHED"
        ? "Too many attempts today. Please try again tomorrow."
        : "Could not start PIN recovery. Please try again.";
    return json({ success: false, error: message });
  }
  const emailContent = pinResetEmail(code);
  const sent = await sendEmail(email, emailContent.subject, emailContent.html, { text: emailContent.text });
  if (!sent.ok) return json({ success: false, error: "Could not send the reset email. Please try again." }, 500);
  return json({ success: true, sent_to: email.replace(/^(.{2}).*(@.*)$/, "$1***$2") });
});
