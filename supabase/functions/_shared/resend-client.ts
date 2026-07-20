// Resend — transactional email for the self-built email verification codes
// (replaces Supabase Auth's own link-based "Confirm email"). Requires a
// verified sending domain in the Resend dashboard; RESEND_FROM_EMAIL must be
// an address on that domain or delivery to real inboxes will fail/spam-box.
const RESEND_API_URL = "https://api.resend.com/emails";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const RESEND_FROM_EMAIL = Deno.env.get("RESEND_FROM_EMAIL");

export function isResendConfigured(): boolean {
  return !!RESEND_API_KEY && !!RESEND_FROM_EMAIL;
}

export async function sendEmail(to: string, subject: string, html: string): Promise<{ ok: boolean; error?: string }> {
  if (!RESEND_API_KEY || !RESEND_FROM_EMAIL) return { ok: false, error: "Resend not configured" };

  try {
    const res = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: RESEND_FROM_EMAIL, to: [to], subject, html }),
    });

    if (!res.ok) {
      const text = await res.text();
      return { ok: false, error: text.slice(0, 300) };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
