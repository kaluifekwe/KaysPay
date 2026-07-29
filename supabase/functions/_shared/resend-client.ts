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

export interface SendEmailOptions {
  /** Override the default From. Use for the founder welcome, e.g.
   *  "Kalu Ifekwe <no-reply@kayspay.com.ng>". The address MUST be on the
   *  verified sending domain or Resend rejects it. */
  from?: string;
  /** Where replies go (the From can be no-reply while replies still reach a
   *  real inbox). */
  replyTo?: string;
  /** Plain-text alternative. Sending a multipart message (text + html) instead
   *  of HTML-only materially improves Gmail/Yahoo inbox placement. */
  text?: string;
}

export async function sendEmail(
  to: string,
  subject: string,
  html: string,
  opts: SendEmailOptions = {},
): Promise<{ ok: boolean; error?: string }> {
  if (!RESEND_API_KEY || !RESEND_FROM_EMAIL) return { ok: false, error: "Resend not configured" };

  try {
    const payload: Record<string, unknown> = {
      from: opts.from || RESEND_FROM_EMAIL,
      to: [to],
      subject,
      html,
    };
    if (opts.text) payload.text = opts.text;
    if (opts.replyTo) payload.reply_to = opts.replyTo;

    const res = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
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
