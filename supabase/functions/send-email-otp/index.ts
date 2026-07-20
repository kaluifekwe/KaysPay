import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { getAuthUser, adminClient } from "../_shared/auth.ts";
import { isResendConfigured, sendEmail } from "../_shared/resend-client.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function generateCode(): string {
  // 6 secure-random digits (000000–999999, left-padded).
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return String(bytes[0] % 1_000_000).padStart(6, "0");
}

function buildEmailHtml(code: string): string {
  return `<!DOCTYPE html><html><body style="font-family: -apple-system, Helvetica, Arial, sans-serif; padding: 24px; color: #111;">
    <div style="max-width: 420px; margin: 0 auto;">
      <h2 style="color: #1A5C3A;">Kay's Pay</h2>
      <p>Enter this code to finish creating your Kay's Pay account.</p>
      <div style="text-align: center; margin: 28px 0; padding: 20px; background: #F0FFF4; border-radius: 10px;">
        <div style="font-size: 32px; font-weight: 800; letter-spacing: 8px; color: #111;">${code}</div>
      </div>
      <p style="font-size: 13px; color: #666;">This code expires in 10 minutes. If you didn't request this, you can safely ignore this email.</p>
    </div>
  </body></html>`;
}

// Only ever verifies the signup email itself — email/phone are fixed at
// signup and never user-editable afterward (owner decision, 2026-07-06).
serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (!isResendConfigured()) return json({ success: false, error: "Email service not configured yet" }, 500);

  const user = await getAuthUser(req);
  if (!user) return json({ success: false, error: "Unauthorized" }, 401);
  if (!user.email) return json({ success: false, error: "No email on this account" }, 400);

  const supabase = adminClient();
  const code = generateCode();

  const { data: createResult, error: createError } = await supabase.rpc("create_email_verification_code", {
    p_user_id: user.id,
    p_purpose: "signup",
    p_target: user.email,
    p_code: code,
  });

  if (createError) return json({ success: false, error: "Could not start verification. Please try again." }, 500);

  if (!createResult?.ok) {
    if (createResult?.error === "RATE_LIMITED") {
      return json({ success: false, error: "Please wait a moment before requesting another code." });
    }
    if (createResult?.error === "DAILY_LIMIT_REACHED") {
      return json({ success: false, error: "Too many attempts today. Please try again tomorrow." });
    }
    return json({ success: false, error: "Could not start verification. Please try again." }, 500);
  }

  const sendResult = await sendEmail(user.email, "Your Kay's Pay verification code", buildEmailHtml(code));
  if (!sendResult.ok) return json({ success: false, error: "Could not send the verification email. Please try again." }, 500);

  return json({ success: true, sent_to: user.email.replace(/^(.{2}).*(@.*)$/, "$1***$2") });
});
