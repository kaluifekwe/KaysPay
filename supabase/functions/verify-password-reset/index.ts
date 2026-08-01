import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import {
  adminClient,
  enforceRateLimit,
  readJsonBody,
  RequestBodyError,
} from "../_shared/auth.ts";
import { isResendConfigured, sendEmail } from "../_shared/resend-client.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Unauthenticated (called with the anon key): verifies the reset code the
// user received by email, and ONLY on success sets the new password via the
// admin API. The code is the sole gate — a valid session is neither present
// nor required. Matches the app signup password floor.
serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  let body: { email?: string; code?: string; newPassword?: string };
  try {
    body = await readJsonBody(req, 4096);
  } catch (error) {
    const e = error instanceof RequestBodyError
      ? error
      : new RequestBodyError(400, "Invalid request body");
    return json({ success: false, error: e.message }, e.status);
  }

  const email = String(body?.email || "").trim().toLowerCase();
  const code = String(body?.code || "").trim();
  const newPassword = String(body?.newPassword || "");

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ success: false, error: "Enter a valid email address" }, 400);
  }
  if (!/^\d{6}$/.test(code)) {
    return json({ success: false, error: "Enter the 6-digit code" }, 400);
  }
  if (newPassword.length < 8) {
    return json({
      success: false,
      error: "Password must be at least 8 characters",
    }, 400);
  }

  const supabase = adminClient();

  const rate = await enforceRateLimit(
    supabase,
    "verify_password_reset",
    email,
    10,
    600,
  );
  if (!rate.allowed) {
    return json({
      success: false,
      error: "Too many verification attempts. Please wait and try again.",
      retry_after_seconds: rate.retryAfterSeconds,
    }, 429);
  }

  const { data: userId, error: lookupError } = await supabase.rpc(
    "get_user_id_by_email",
    { p_email: email },
  );
  if (lookupError) {
    return json({
      success: false,
      error: "Could not verify code. Please try again.",
    }, 500);
  }
  // Unknown email: respond exactly like a wrong/expired code — no enumeration.
  if (!userId) {
    return json({ success: false, error: "Request a new code and try again." });
  }

  const { data: result, error: verifyError } = await supabase.rpc(
    "verify_email_verification_code",
    {
      p_user_id: userId,
      p_purpose: "password_reset",
      p_target: email,
      p_code: code,
    },
  );

  if (verifyError) {
    return json({
      success: false,
      error: "Could not verify code. Please try again.",
    }, 500);
  }

  if (!result?.valid) {
    if (result?.error === "EXPIRED") {
      return json({
        success: false,
        error: "This code has expired. Request a new one.",
      });
    }
    if (result?.error === "NOT_FOUND") {
      return json({
        success: false,
        error: "Request a new code and try again.",
      });
    }
    if (result?.locked) {
      return json({
        success: false,
        error: "Too many wrong attempts. Request a new code.",
      });
    }
    return json({
      success: false,
      error: "Incorrect code. Please try again.",
      attempts_remaining: result?.attempts_remaining,
    });
  }

  // Code confirmed — set the new password. This is the only place a reset can
  // change the credential; the code row was marked used inside the verify RPC.
  const { error: updateError } = await supabase.auth.admin.updateUserById(
    userId,
    { password: newPassword },
  );
  if (updateError) {
    return json({
      success: false,
      error: "Could not update your password. Please try again.",
    }, 500);
  }

  // A password reset is an account-recovery boundary: registered sessions on
  // every device are revoked and must authenticate again for sensitive work.
  await supabase.rpc("revoke_all_device_sessions", { p_user_id: userId });
  if (isResendConfigured()) {
    await sendEmail(
      email,
      "Your Kay's Pay password was changed",
      "<p>Your Kay's Pay password was reset successfully, and registered device sessions were revoked.</p><p>If this wasn't you, contact support immediately.</p>",
      {
        text:
          "Your Kay's Pay password was reset and registered device sessions were revoked. If this wasn't you, contact support immediately.",
      },
    );
  }

  return json({ success: true });
});
