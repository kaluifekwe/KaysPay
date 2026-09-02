// One branded shell for every KaysPay transactional email. The logo is
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
            <td style="vertical-align:middle;"><img src="${LOGO_URL}" width="36" height="36" alt="KaysPay" style="display:block;border-radius:9px;"></td>
            <td style="vertical-align:middle;padding-left:12px;color:#ffffff;font-size:18px;font-weight:800;letter-spacing:.2px;">KaysPay</td>
          </tr></table>
        </td></tr>
        ${inner}
        <tr><td style="padding:22px 28px;background:#fafbfa;border-top:1px solid ${LINE};">
          <p style="margin:0 0 4px;font-size:12px;color:${MUTED};line-height:1.6;">KaysPay. Airtime, data, bills &amp; wallet, made simple.</p>
          <p style="margin:0;font-size:12px;color:${MUTED};line-height:1.6;">Need help? <a href="mailto:${SUPPORT_EMAIL}" style="color:${ACCENT};text-decoration:none;">${SUPPORT_EMAIL}</a></p>
          <p style="margin:10px 0 0;font-size:11px;color:#9aa8a1;">© 2026 KaysPay. All rights reserved.</p>
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
    "KAYSPAY",
    "",
    ...lines,
    "",
    "----",
    "KaysPay. Airtime, data, bills & wallet, made simple.",
    `Need help? ${SUPPORT_EMAIL}`,
    "© 2026 KaysPay. All rights reserved.",
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
        <tr><td align="center" style="padding:22px 0 6px;">
          <div style="font-size:34px;font-weight:800;letter-spacing:6px;color:${DEEP};font-family:${FONT};">${esc(code)}</div>
        </td></tr>
        <tr><td align="center" style="padding:0 0 16px;">
          <p style="margin:0;font-size:12px;color:${MUTED};">Tap and hold the code above, then Copy</p>
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
  const lead = "Enter this code in the app to finish creating your KaysPay account.";
  const note = "This code expires in <b>10 minutes</b>. If you didn't try to sign up, you can safely ignore this email.";
  return {
    subject: "Your KaysPay verification code",
    html: shell(codeBlock(title, lead, code, note), "Your KaysPay verification code"),
    text: codeText(title, lead, code, note),
  };
}

/** Forgot-password reset code. */
export function passwordResetEmail(code: string): { subject: string; html: string; text: string } {
  const title = "Reset your password";
  const lead = "We received a request to reset your KaysPay password. Enter this code in the app to set a new one.";
  const note = "This code expires in <b>10 minutes</b>. If you didn't request this, your password is unchanged, so you can safely ignore this email.";
  return {
    subject: "Reset your KaysPay password",
    html: shell(codeBlock(title, lead, code, note), "Reset your KaysPay password"),
    text: codeText(title, lead, code, note),
  };
}

/** Transaction-PIN reset code. */
export function pinResetEmail(code: string): { subject: string; html: string; text: string } {
  const title = "Reset your transaction PIN";
  const lead = "Enter this code in the KaysPay app to create a new transaction PIN.";
  const note = "This code expires in <b>10 minutes</b>. If you didn't request this, do not share the code and contact support immediately.";
  return {
    subject: "Reset your KaysPay transaction PIN",
    html: shell(codeBlock(title, lead, code, note), "Reset your KaysPay transaction PIN"),
    text: codeText(title, lead, code, note),
  };
}

/** After-the-fact security alert following a successful PIN reset. */
export function pinResetNoticeEmail(): { subject: string; html: string; text: string } {
  const title = "Your transaction PIN was changed";
  const lead = "Your KaysPay transaction PIN was reset successfully.";
  const note = `If this wasn't you, contact ${SUPPORT_EMAIL} immediately.`;
  const inner = `
    <tr><td style="padding:30px 28px;">
      <h1 style="margin:0 0 10px;font-size:20px;color:${INK};font-weight:800;">${title}</h1>
      <p style="margin:0 0 14px;font-size:15px;color:${MUTED};line-height:1.6;">${lead}</p>
      <p style="margin:0;font-size:15px;color:${MUTED};line-height:1.6;">${note}</p>
    </td></tr>`;
  return {
    subject: "Your KaysPay transaction PIN was changed",
    html: shell(inner, title),
    text: textShell([title, "", lead, "", note]),
  };
}

/** Confirms a phone/email change requested from Edit Profile. */
export function profileChangeCodeEmail(
  fieldLabel: string,
  pendingValue: string,
  code: string,
): { subject: string; html: string; text: string } {
  const title = `Confirm your ${fieldLabel} change`;
  const safePendingValue = esc(pendingValue);
  const lead = `Enter this code in the app to confirm you want to change your account's ${fieldLabel} to <b>${safePendingValue}</b>. If you didn't request this exact change, do not share this code — someone else may have access to your account.`;
  const textLead = `Enter this code in the app to confirm you want to change your account's ${fieldLabel} to ${pendingValue}. If you didn't request this exact change, do not share this code — someone else may have access to your account.`;
  const note = "This code expires in <b>10 minutes</b>.";
  return {
    subject: `Confirm your KaysPay ${fieldLabel} change`,
    html: shell(codeBlock(title, lead, code, note), `Confirm your KaysPay ${fieldLabel} change`),
    text: codeText(title, textLead, code, note),
  };
}

/** After-the-fact alert sent to the OLD email once a phone/email change is applied. */
export function profileChangedNoticeEmail(fieldLabel: string): { subject: string; html: string; text: string } {
  const title = `Your ${fieldLabel} was changed`;
  const inner = `
    <tr><td style="padding:30px 28px 6px;">
      <h1 style="margin:0 0 10px;font-size:20px;color:${INK};font-weight:800;">${title}</h1>
      <p style="margin:0 0 14px;font-size:15px;color:${MUTED};line-height:1.6;">Your KaysPay account's ${fieldLabel} was just changed.</p>
      <p style="margin:0;font-size:15px;color:${MUTED};line-height:1.6;">If this wasn't you, contact <a href="mailto:${SUPPORT_EMAIL}" style="color:${ACCENT};text-decoration:none;">${SUPPORT_EMAIL}</a> immediately.</p>
    </td></tr>`;
  return {
    subject: `Your KaysPay ${fieldLabel} was changed`,
    html: shell(inner, `Your KaysPay ${fieldLabel} was changed`),
    text: textShell([
      title,
      "",
      `Your KaysPay account's ${fieldLabel} was just changed.`,
      "",
      `If this wasn't you, contact ${SUPPORT_EMAIL} immediately.`,
    ]),
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

// WhatsApp's own brand green is #25D366, but white text on it only reaches
// ~2:1 contrast — genuinely hard to read. This deepened green keeps the
// unmistakable WhatsApp association at ~4.4:1 against white.
const WHATSAPP_GREEN = "#0E8A43";
const WHATSAPP_PANEL_BG = "#f1fbf5";
const WHATSAPP_PANEL_LINE = "#bfe8cf";
const WHATSAPP_EYEBROW = "#0b7a3b";

/**
 * Only a real WhatsApp group invite is ever rendered. This email goes to
 * every new user, so a mistyped or malicious value in the admin-editable
 * setting must never become a link we vouch for — anything that isn't a
 * chat.whatsapp.com invite is dropped and the block is omitted entirely
 * rather than shipping a broken or untrustworthy button.
 */
function safeWhatsAppGroupUrl(url: string | null | undefined): string | null {
  const trimmed = String(url ?? "").trim();
  if (!trimmed) return null;
  if (!/^https:\/\/chat\.whatsapp\.com\/[A-Za-z0-9]/.test(trimmed)) return null;
  return trimmed;
}

/** Founder welcome, sent ~10 minutes after signup by the welcome-email cron. */
export function welcomeEmail(
  firstName: string,
  whatsappGroupUrl?: string | null,
): { subject: string; html: string; text: string } {
  const name = firstName && firstName.trim() ? esc(firstName.trim()) : "there";
  const plainName = firstName && firstName.trim() ? firstName.trim() : "there";
  const groupUrl = safeWhatsAppGroupUrl(whatsappGroupUrl);
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

  // Sits between the numbered steps and "reply to this email", so the two
  // support channels read as a pair: the community first, then the direct
  // line to the founder. Omitted entirely when no valid group URL is set.
  const whatsappBlock = groupUrl
    ? `
    <tr><td style="padding:6px 28px 4px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${WHATSAPP_PANEL_BG};border:1px solid ${WHATSAPP_PANEL_LINE};border-radius:12px;">
        <tr><td style="padding:18px 18px 16px;">
          <div style="font-size:11px;font-weight:800;letter-spacing:.7px;text-transform:uppercase;color:${WHATSAPP_EYEBROW};margin-bottom:7px;">WhatsApp community</div>
          <div style="font-size:16px;font-weight:800;color:${INK};margin-bottom:6px;">Join our WhatsApp group</div>
          <div style="font-size:14px;color:${MUTED};line-height:1.55;margin-bottom:14px;">Get quick help when you need it, hear about new features first, and tell us what to build next. It's the fastest way to reach us, and to meet other people using KaysPay.</div>
          <table role="presentation" cellpadding="0" cellspacing="0"><tr>
            <td style="background:${WHATSAPP_GREEN};border-radius:10px;">
              <a href="${esc(groupUrl)}" style="display:inline-block;padding:12px 20px;font-size:15px;font-weight:800;color:#ffffff;text-decoration:none;">Join the WhatsApp group →</a>
            </td>
          </tr></table>
          <div style="font-size:12px;color:${MUTED};line-height:1.5;margin-top:12px;">Or open this link: <a href="${esc(groupUrl)}" style="color:${ACCENT};text-decoration:none;">${esc(groupUrl)}</a></div>
        </td></tr>
      </table>
    </td></tr>`
    : "";

  const inner = `
    <tr><td style="padding:30px 28px 6px;">
      <h1 style="margin:0 0 14px;font-size:21px;color:${INK};font-weight:800;">Welcome to KaysPay 🎉</h1>
      <p style="margin:0 0 14px;font-size:15px;color:${INK};line-height:1.65;">Hi <b>${name}</b>,</p>
      <p style="margin:0 0 14px;font-size:15px;color:${INK};line-height:1.65;">I'm <b>Kalu Ifekwe</b>, the founder of KaysPay. I wanted to personally say hello, and thank you for joining us.</p>
      <p style="margin:0 0 18px;font-size:15px;color:${INK};line-height:1.65;">I built KaysPay on one simple belief: paying for the things we use every day, like airtime, data, electricity, TV and exam pins, should be fast, fairly priced, and reliable, even when the network isn't at its best.</p>
      <p style="margin:0 0 14px;font-size:13px;font-weight:800;letter-spacing:.6px;text-transform:uppercase;color:${ACCENT};">Here's what you can do</p>
    </td></tr>
    <tr><td style="padding:0 28px 6px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${steps}</table>
    </td></tr>
    ${whatsappBlock}
    <tr><td style="padding:${groupUrl ? "14px" : "8px"} 28px 4px;">
      <p style="margin:0 0 14px;font-size:15px;color:${INK};line-height:1.65;">If you ever have a question, an issue, or even just an idea, reply to this email. It comes straight to my team and me, and we read every one.</p>
      <p style="margin:0 0 4px;font-size:15px;color:${INK};line-height:1.65;">Thanks for trusting us with the little things that matter every day. We're only just getting started.</p>
    </td></tr>
    <tr><td style="padding:16px 28px 30px;">
      <p style="margin:0 0 12px;font-size:15px;color:${MUTED};line-height:1.6;">Warmly,</p>
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td style="vertical-align:middle;"><div style="width:40px;height:40px;border-radius:50%;background:${SOFT};border:1px solid ${LINE};color:${GREEN};font-size:16px;font-weight:800;text-align:center;line-height:40px;">K</div></td>
        <td style="vertical-align:middle;padding-left:12px;">
          <div style="font-size:14px;font-weight:800;color:${INK};">Kalu Ifekwe</div>
          <div style="font-size:13px;color:${MUTED};">Founder, KaysPay</div>
        </td>
      </tr></table>
    </td></tr>`;

  const text = textShell([
    "Welcome to KaysPay",
    "",
    `Hi ${plainName},`,
    "",
    "I'm Kalu Ifekwe, the founder of KaysPay. I wanted to personally say hello, and thank you for joining us.",
    "",
    "I built KaysPay on one simple belief: paying for the things we use every day, like airtime, data, electricity, TV and exam pins, should be fast, fairly priced, and reliable, even when the network isn't at its best.",
    "",
    "HERE'S WHAT YOU CAN DO",
    ...WELCOME_STEPS.map(([t, d], i) => `${i + 1}. ${t} — ${d.replace(/&amp;/g, "&")}`),
    // Gmail/Yahoo score HTML-only mail worse for spam, so the text part has
    // to carry the invite too — not just the HTML.
    ...(groupUrl
      ? [
        "",
        "JOIN OUR WHATSAPP GROUP",
        "Get quick help when you need it, hear about new features first, and tell us what to build next.",
        groupUrl,
      ]
      : []),
    "",
    "If you ever have a question, an issue, or even just an idea, reply to this email. It comes straight to my team and me, and we read every one.",
    "",
    "Warmly,",
    "Kalu Ifekwe",
    "Founder, KaysPay",
  ]);

  return { subject: "Welcome to KaysPay 🎉", html: shell(inner, "A note from the founder"), text };
}

const PLAY_STORE_URL = "https://play.google.com/store/apps/details?id=com.kayspay.app";

/**
 * Transactional, not marketing: about finishing THEIR OWN incomplete signup,
 * same category as the welcome email above -- never gated on marketing
 * consent (customer_marketing_preferences), sent once per account by the
 * kyc-reminder-email cron. Deliberately does not lead with the cashback/
 * discount line -- mentioned once, factually, as a reason to finish, not
 * the headline -- keeping this honestly a service reminder, not a promo.
 */
export function kycReminderEmail(firstName: string): { subject: string; html: string; text: string } {
  const name = firstName && firstName.trim() ? esc(firstName.trim()) : "there";
  const plainName = firstName && firstName.trim() ? firstName.trim() : "there";

  const inner = `
    <tr><td style="padding:30px 28px 6px;">
      <h1 style="margin:0 0 14px;font-size:21px;color:${INK};font-weight:800;">One step left, ${name}</h1>
      <p style="margin:0 0 14px;font-size:15px;color:${INK};line-height:1.65;">You started setting up KaysPay, but your account isn't finished yet — you still need to verify your identity.</p>
      <p style="margin:0 0 18px;font-size:15px;color:${INK};line-height:1.65;">It's free and takes under a minute — no documents, no photos. Open the app and we'll show you exactly what's needed. Once that's done, you can fund your wallet and start paying for airtime, data, electricity, TV and more — and every data purchase automatically comes with a discount plus cashback.</p>
    </td></tr>
    <tr><td style="padding:6px 28px 30px;">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td style="background:${GREEN};border-radius:10px;">
          <a href="${PLAY_STORE_URL}" style="display:inline-block;padding:13px 22px;font-size:15px;font-weight:800;color:#ffffff;text-decoration:none;">Open KaysPay to finish →</a>
        </td>
      </tr></table>
      <p style="margin:16px 0 0;font-size:12px;color:${MUTED};line-height:1.5;">Or open this link on your phone: <a href="${PLAY_STORE_URL}" style="color:${ACCENT};text-decoration:none;">${PLAY_STORE_URL}</a></p>
    </td></tr>`;

  const text = textShell([
    `One step left, ${plainName}`,
    "",
    "You started setting up KaysPay, but your account isn't finished yet -- you still need to verify your identity.",
    "",
    "It's free and takes under a minute -- no documents, no photos. Open the app and we'll show you exactly what's needed. Once that's done, you can fund your wallet and start paying for airtime, data, electricity, TV and more -- and every data purchase automatically comes with a discount plus cashback.",
    "",
    "Open KaysPay to finish:",
    PLAY_STORE_URL,
  ]);

  return { subject: `${plainName === "there" ? "Finish setting up" : `${plainName}, finish setting up`} your KaysPay account`, html: shell(inner, "You're one step from finishing your KaysPay setup"), text };
}
