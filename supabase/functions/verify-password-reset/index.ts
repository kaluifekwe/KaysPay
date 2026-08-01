import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { adminClient } from "../_shared/auth.ts";

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
    body = await req.json();
  } catch {
    return json({ success: false, error: "Invalid request body" }, 400);
  }

  const email = String(body?.email || "").trim().toLowerCase();
  const code = String(body?.code || "").trim();
  const newPassword = String(body?.newPassword || "");

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ success: false, error: "Enter a valid email address" }, 400);
  if (!/^\d{6}$/.test(code)) return json({ success: false, error: "Enter the 6-digit code" }, 400);
  if (newPassword.length < 10) return json({ success: false, error: "Password must be at least 10 characters" }, 400);

  const supabase = adminClient();

  const { data: userId, error: lookupError } = await supabase.rpc("get_user_id_by_email", { p_email: email });
  if (lookupError) return json({ success: false, error: "Could not verify code. Please try again." }, 500);
  // Unknown email: respond exactly like a wrong/expired code — no enumeration.
  if (!userId) return json({ success: false, error: "Request a new code and try again." });

  const { data: result, error: verifyError } = await supabase.rpc("verify_email_verification_code", {
    p_user_id: userId,
    p_purpose: "password_reset",
    p_target: email,
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

  // Code confirmed — set the new password. This is the only place a reset can
  // change the credential; the code row was marked used inside the verify RPC.
  const { error: updateError } = await supabase.auth.admin.updateUserById(userId, { password: newPassword });
  if (updateError) return json({ success: false, error: "Could not update your password. Please try again." }, 500);

  return json({ success: true });
});
