// One branded shell for every Kay's Pay transactional email. The logo is
// served from a public Supabase Storage bucket ('branding') because email
// clients block local/base64/inline images — a hosted https URL is the only
// reliable way to render a logo in Gmail/Outlook/Apple Mail.
//
// Design signed off by the owner (2026-07-23): green header + app-icon badge,
// generous white body, support footer. Code emails (signup + reset) are kept
// visually near-identical on purpose so both read as trusted.

const LOGO_URL = "https://xswlrzhtxrzugoxdonjc.supabase.co/storage/v1/object/public/branding/kayspay-logo.png";
const SUPPORT_EMAIL = "support@kayspay.com.ng";

const GREEN = "#1A5C3A";
const DEEP = "#0F3D27";
const ACCENT = "#1a7a4a";
const INK = "#12201a";
const MUTED = "#5b6b63";
const LINE = "#e5eae7";
const SOFT = "#F0F7F2";
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/** Escape user-supplied text (e.g. a name) before dropping it into email HTML. */
function esc(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function shell(inner: string, preheader: string): string {
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#eef2f0;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preheader)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef2f0;padding:24px 12px;font-family:${FONT};">
    <tr><td align="center">
      <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="width:480px;max-width:480px;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid ${LINE};">
        <tr><td style="background:${GREEN};padding:22px 28px;" align="left">
          <table role="presentation" cellpadding="0" cellspacing="0"><tr>
            <td style="vertical-align:middle;"><img src="${LOGO_URL}" width="36" height="36" alt="Kay's Pay" style="display:block;border-radius:9px;"></td>
            <td style="vertical-align:middle;padding-left:12px;color:#ffffff;font-size:18px;font-weight:800;letter-spacing:.2px;">Kay's Pay</td>
          </tr></table>
        </td></tr>
        ${inner}
        <tr><td style="padding:22px 28px;background:#fafbfa;border-top:1px solid ${LINE};">
          <p style="margin:0 0 4px;font-size:12px;color:${MUTED};line-height:1.6;">Kay's Pay. Airtime, data, bills &amp; wallet, made simple.</p>
          <p style="margin:0;font-size:12px;color:${MUTED};line-height:1.6;">Need help? <a href="mailto:${SUPPORT_EMAIL}" style="color:${ACCENT};text-decoration:none;">${SUPPORT_EMAIL}</a></p>
          <p style="margin:10px 0 0;font-size:11px;color:#9aa8a1;">© 2026 Kay's Pay. All rights reserved.</p>
        </td></tr>
      </table>
    </td></tr>
  </table></body></html>`;
}

// Plain-text alternative for every email. A multipart message with a real
// text/plain part scores markedly better with Gmail/Yahoo spam filters than
// HTML-only mail, and it's what shows in clients that don't render HTML.
function textShell(lines: string[]): string {
  return [
    "KAY'S PAY",
    "",
    ...lines,
    "",
    "----",
    "Kay's Pay. Airtime, data, bills & wallet, made simple.",
    `Need help? ${SUPPORT_EMAIL}`,
    "© 2026 Kay's Pay. All rights reserved.",
  ].join("\n");
}

function codeText(title: string, lead: string, code: string, note: string): string {
  return textShell([title, "", lead, "", `    ${code}`, "", note.replace(/<\/?b>/g, "")]);
}

function codeBlock(title: string, lead: string, code: string, note: string): string {
  return `
    <tr><td style="padding:30px 28px 8px;">
      <h1 style="margin:0 0 10px;font-size:20px;color:${INK};font-weight:800;">${title}</h1>
      <p style="margin:0;font-size:15px;color:${MUTED};line-height:1.6;">${lead}</p>
    </td></tr>
    <tr><td style="padding:22px 28px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${SOFT};border:1px solid ${LINE};border-radius:12px;">
        <tr><td align="center" style="padding:22px 0;">
          <div style="font-size:34px;font-weight:800;letter-spacing:12px;color:${DEEP};font-family:${FONT};">${esc(code)}</div>
        </td></tr>
      </table>
    </td></tr>
    <tr><td style="padding:0 28px 28px;">
      <p style="margin:0;font-size:13px;color:${MUTED};line-height:1.6;">${note}</p>
    </td></tr>`;
}

/** Signup email-verification code. */
export function otpEmail(code: string): { subject: string; html: string; text: string } {
  const title = "Verify your email";
  const lead = "Enter this code in the app to finish creating your Kay's Pay account.";
  const note = "This code expires in <b>10 minutes</b>. If you didn't try to sign up, you can safely ignore this email.";
  return {
    subject: "Your Kay's Pay verification code",
    html: shell(codeBlock(title, lead, code, note), "Your Kay's Pay verification code"),
    text: codeText(title, lead, code, note),
  };
}

/** Forgot-password reset code. */
export function passwordResetEmail(code: string): { subject: string; html: string; text: string } {
  const title = "Reset your password";
  const lead = "We received a request to reset your Kay's Pay password. Enter this code in the app to set a new one.";
  const note = "This code expires in <b>10 minutes</b>. If you didn't request this, your password is unchanged, so you can safely ignore this email.";
  return {
    subject: "Reset your Kay's Pay password",
    html: shell(codeBlock(title, lead, code, note), "Reset your Kay's Pay password"),
    text: codeText(title, lead, code, note),
  };
}

const WELCOME_STEPS: [string, string][] = [
  ["Fund your wallet", "Add money instantly by bank transfer or card. It powers everything below."],
  ["Buy airtime or data", "Any network, any amount. We auto-detect MTN, Airtel, Glo &amp; 9mobile for you."],
  ["Verify NIN &amp; BVN", "Confirm your identity details in seconds, right from your phone."],
  ["Get a foreign number", "Virtual international numbers for receiving SMS and OTPs from abroad."],
  ["Buy a travel eSIM", "Instant mobile data in 200+ countries and regions, no physical SIM needed."],
  ["Explore the rest", "Electricity, TV subscriptions and exam pins are all in there too."],
];

/** Founder welcome, sent ~10 minutes after signup by the welcome-email cron. */
export function welcomeEmail(firstName: string): { subject: string; html: string; text: string } {
  const name = firstName && firstName.trim() ? esc(firstName.trim()) : "there";
  const plainName = firstName && firstName.trim() ? firstName.trim() : "there";
  const steps = WELCOME_STEPS.map(
    ([t, d], i) => `
    <tr><td style="padding:0 0 16px;">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>
        <td width="30" style="vertical-align:top;">
          <div style="width:26px;height:26px;border-radius:50%;background:${GREEN};color:#fff;font-size:13px;font-weight:800;text-align:center;line-height:26px;">${i + 1}</div>
        </td>
        <td style="vertical-align:top;padding-left:12px;">
          <div style="font-size:15px;font-weight:700;color:${INK};margin-bottom:2px;">${t}</div>
          <div style="font-size:14px;color:${MUTED};line-height:1.55;">${d}</div>
        </td>
      </tr></table>
    </td></tr>`,
  ).join("");

  const inner = `
    <tr><td style="padding:30px 28px 6px;">
      <h1 style="margin:0 0 14px;font-size:21px;color:${INK};font-weight:800;">Welcome to Kay's Pay 🎉</h1>
      <p style="margin:0 0 14px;font-size:15px;color:${INK};line-height:1.65;">Hi <b>${name}</b>,</p>
      <p style="margin:0 0 14px;font-size:15px;color:${INK};line-height:1.65;">I'm <b>Kalu Ifekwe</b>, the founder of Kay's Pay. I wanted to personally say hello, and thank you for joining us.</p>
      <p style="margin:0 0 18px;font-size:15px;color:${INK};line-height:1.65;">I built Kay's Pay on one simple belief: paying for the things we use every day, like airtime, data, electricity, TV and exam pins, should be fast, fairly priced, and reliable, even when the network isn't at its best.</p>
      <p style="margin:0 0 14px;font-size:13px;font-weight:800;letter-spacing:.6px;text-transform:uppercase;color:${ACCENT};">Here's what you can do</p>
    </td></tr>
    <tr><td style="padding:0 28px 6px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${steps}</table>
    </td></tr>
    <tr><td style="padding:8px 28px 4px;">
      <p style="margin:0 0 14px;font-size:15px;color:${INK};line-height:1.65;">If you ever have a question, an issue, or even just an idea, reply to this email. It comes straight to my team and me, and we read every one.</p>
      <p style="margin:0 0 4px;font-size:15px;color:${INK};line-height:1.65;">Thanks for trusting us with the little things that matter every day. We're only just getting started.</p>
    </td></tr>
    <tr><td style="padding:16px 28px 30px;">
      <p style="margin:0 0 12px;font-size:15px;color:${MUTED};line-height:1.6;">Warmly,</p>
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td style="vertical-align:middle;"><div style="width:40px;height:40px;border-radius:50%;background:${SOFT};border:1px solid ${LINE};color:${GREEN};font-size:16px;font-weight:800;text-align:center;line-height:40px;">K</div></td>
        <td style="vertical-align:middle;padding-left:12px;">
          <div style="font-size:14px;font-weight:800;color:${INK};">Kalu Ifekwe</div>
          <div style="font-size:13px;color:${MUTED};">Founder, Kay's Pay</div>
        </td>
      </tr></table>
    </td></tr>`;

  const text = textShell([
    "Welcome to Kay's Pay",
    "",
    `Hi ${plainName},`,
    "",
    "I'm Kalu Ifekwe, the founder of Kay's Pay. I wanted to personally say hello, and thank you for joining us.",
    "",
    "I built Kay's Pay on one simple belief: paying for the things we use every day, like airtime, data, electricity, TV and exam pins, should be fast, fairly priced, and reliable, even when the network isn't at its best.",
    "",
    "HERE'S WHAT YOU CAN DO",
    ...WELCOME_STEPS.map(([t, d], i) => `${i + 1}. ${t} — ${d.replace(/&amp;/g, "&")}`),
    "",
    "If you ever have a question, an issue, or even just an idea, reply to this email. It comes straight to my team and me, and we read every one.",
    "",
    "Warmly,",
    "Kalu Ifekwe",
    "Founder, Kay's Pay",
  ]);

  return { subject: "Welcome to Kay's Pay 🎉", html: shell(inner, "A note from the founder"), text };
}
