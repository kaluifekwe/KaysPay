import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import {
  adminClient,
  enforceRateLimit,
  getAuthUser,
  isDeviceSessionAllowed,
  readJsonBody,
  RequestBodyError,
} from "../_shared/auth.ts";
import { isResendConfigured, sendEmail } from "../_shared/resend-client.ts";
import { profileChangedNoticeEmail } from "../_shared/email-template.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Step 2: verifies the code emailed by request-profile-change and, only on
// success, applies the pending change and alerts the (old) email that it
// happened. The code is the sole remaining gate here — the PIN step-up
// already happened in step 1.
serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  const user = await getAuthUser(req);
  if (!user) return json({ success: false, error: "Unauthorized" }, 401);
  if (!user.email) return json({ success: false, error: "No email on this account" }, 400);

  const supabase = adminClient();

  if (!(await isDeviceSessionAllowed(req, supabase, user.id))) {
    return json({ success: false, error: "This device session has been revoked. Please log in again." }, 401);
  }

  let body: { field?: string; code?: string };
  try {
    body = await readJsonBody(req, 512);
  } catch (error) {
    const e = error instanceof RequestBodyError ? error : new RequestBodyError(400, "Invalid request body");
    return json({ success: false, error: e.message }, e.status);
  }

  const field = body.field === "email" ? "email" : body.field === "phone" ? "phone" : null;
  if (!field) return json({ success: false, error: "Invalid field" }, 400);

  const code = String(body.code || "").trim();
  if (!/^\d{6}$/.test(code)) return json({ success: false, error: "Enter the 6-digit code" }, 400);

  const rate = await enforceRateLimit(supabase, "confirm_profile_change", user.id, 10, 600, user.id);
  if (!rate.allowed) {
    return json({ success: false, error: "Too many attempts. Please wait and try again." }, 429);
  }

  const { data: result, error: verifyError } = await supabase.rpc("verify_and_consume_profile_change", {
    p_user_id: user.id,
    p_field: field,
    p_code: code,
  });
  if (verifyError) return json({ success: false, error: "Could not verify code. Please try again." }, 500);

  if (!result?.valid) {
    if (result?.error === "EXPIRED") return json({ success: false, error: "This code has expired. Request a new one." });
    if (result?.error === "NOT_FOUND") return json({ success: false, error: "Request a new code and try again." });
    if (result?.locked) return json({ success: false, error: "Too many wrong attempts. Request a new code." });
    return json({
      success: false,
      error: "Incorrect code. Please try again.",
      attempts_remaining: result?.attempts_remaining,
    });
  }

  const newValue = typeof result?.new_value === "string" ? result.new_value : null;
  if (!newValue) return json({ success: false, error: "This request has expired. Please start again." }, 400);

  const oldEmail = user.email;

  if (field === "email") {
    // email_confirm: true is required here — without it, Supabase Admin API
    // only STAGES the new address (auth.users.email_change) and waits for
    // its OWN separate confirmation link, which this app never sends (we
    // use our own OTP instead). Omitting this flag would silently leave
    // auth.users.email unchanged forever: the old email would keep working
    // for login and the new one would never take effect, even though the
    // OTP step above already proved the caller controls this account.
    const { error: updateError } = await supabase.auth.admin.updateUserById(user.id, {
      email: newValue,
      email_confirm: true,
    });
    if (updateError) return json({ success: false, error: updateError.message || "Could not update your email." }, 500);
  } else {
    const meta = (user.user_metadata || {}) as Record<string, unknown>;
    const { error: updateError } = await supabase.auth.admin.updateUserById(user.id, {
      user_metadata: { ...meta, phone: newValue },
    });
    if (updateError) return json({ success: false, error: updateError.message || "Could not update your phone number." }, 500);
  }

  // Record only which field changed. Old/new values are deliberately omitted
  // so the security event stream does not become a second store of PII.
  const { error: auditError } = await supabase.from("security_events").insert({
    user_id: user.id,
    event_type: "profile_changed",
    severity: "warning",
    source: "profile-change",
    metadata: { field },
  });
  if (auditError) {
    console.error("Could not record profile-change security event");
  }

  if (isResendConfigured()) {
    const fieldLabel = field === "email" ? "email address" : "phone number";
    const { subject, html, text } = profileChangedNoticeEmail(fieldLabel);
    await sendEmail(oldEmail, subject, html, { text });
  }

  return json({ success: true, new_value: newValue });
});
