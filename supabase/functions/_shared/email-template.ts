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
 * Only a real WhatsApp group invite or channel link is ever rendered. This
 * email goes to every new user, so a mistyped or malicious value in the
 * admin-editable setting must never become a link we vouch for — anything
 * that isn't a chat.whatsapp.com invite or a whatsapp.com/channel/ link is
 * dropped and the block is omitted entirely rather than shipping a broken
 * or untrustworthy button. Groups and channels are different WhatsApp
 * products (channels are one-way broadcast, groups are two-way chat), so
 * the caller needs to know which one it got to word the block correctly.
 */
function safeWhatsAppCommunityLink(url: string | null | undefined): { url: string; kind: "group" | "channel" } | null {
  const trimmed = String(url ?? "").trim();
  if (!trimmed) return null;
  if (/^https:\/\/chat\.whatsapp\.com\/[A-Za-z0-9]/.test(trimmed)) return { url: trimmed, kind: "group" };
  if (/^https:\/\/(www\.)?whatsapp\.com\/channel\/[A-Za-z0-9]{10,}$/.test(trimmed)) return { url: trimmed, kind: "channel" };
  return null;
}

/** Founder welcome, sent ~10 minutes after signup by the welcome-email cron. */
export function welcomeEmail(
  firstName: string,
  whatsappGroupUrl?: string | null,
): { subject: string; html: string; text: string } {
  const name = firstName && firstName.trim() ? esc(firstName.trim()) : "there";
  const plainName = firstName && firstName.trim() ? firstName.trim() : "there";
  const community = safeWhatsAppCommunityLink(whatsappGroupUrl);
  const communityWord = community?.kind === "channel" ? "channel" : "group";
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
  // line to the founder. Omitted entirely when no valid group/channel URL
  // is set. Description text deliberately differs by kind -- a WhatsApp
  // channel is one-way broadcast (no replies, no seeing other members), so
  // promising "tell us what to build next" or "meet other people" there
  // would be a real, factual overpromise, not just a wording nitpick.
  const whatsappDescription = communityWord === "channel"
    ? "Get updates on new features and announcements straight from us. It's the fastest way to stay in the loop."
    : "Get quick help when you need it, hear about new features first, and tell us what to build next. It's the fastest way to reach us, and to meet other people using KaysPay.";
  const whatsappBlock = community
    ? `
    <tr><td style="padding:6px 28px 4px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${WHATSAPP_PANEL_BG};border:1px solid ${WHATSAPP_PANEL_LINE};border-radius:12px;">
        <tr><td style="padding:18px 18px 16px;">
          <div style="font-size:11px;font-weight:800;letter-spacing:.7px;text-transform:uppercase;color:${WHATSAPP_EYEBROW};margin-bottom:7px;">WhatsApp community</div>
          <div style="font-size:16px;font-weight:800;color:${INK};margin-bottom:6px;">Join our WhatsApp ${communityWord}</div>
          <div style="font-size:14px;color:${MUTED};line-height:1.55;margin-bottom:14px;">${whatsappDescription}</div>
          <table role="presentation" cellpadding="0" cellspacing="0"><tr>
            <td style="background:${WHATSAPP_GREEN};border-radius:10px;">
              <a href="${esc(community.url)}" style="display:inline-block;padding:12px 20px;font-size:15px;font-weight:800;color:#ffffff;text-decoration:none;">Join the WhatsApp ${communityWord} →</a>
            </td>
          </tr></table>
          <div style="font-size:12px;color:${MUTED};line-height:1.5;margin-top:12px;">Or open this link: <a href="${esc(community.url)}" style="color:${ACCENT};text-decoration:none;">${esc(community.url)}</a></div>
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
    <tr><td style="padding:${community ? "14px" : "8px"} 28px 4px;">
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
    ...(community
      ? [
        "",
        `JOIN OUR WHATSAPP ${communityWord.toUpperCase()}`,
        whatsappDescription,
        community.url,
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
      <p style="margin:0 0 14px;font-size:15px;color:${INK};line-height:1.65;">You started setting up KaysPay, but your account isn't finished yet. You still need to verify your identity.</p>
      <p style="margin:0 0 18px;font-size:15px;color:${INK};line-height:1.65;">It's free and takes under a minute. No documents, no photos. Open the app and we'll show you exactly what's needed. Once that's done, you can fund your wallet and start paying for airtime, data, electricity, TV and more. Every data purchase automatically comes with a discount plus cashback.</p>
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
    "You started setting up KaysPay, but your account isn't finished yet. You still need to verify your identity.",
    "",
    "It's free and takes under a minute. No documents, no photos. Open the app and we'll show you exactly what's needed. Once that's done, you can fund your wallet and start paying for airtime, data, electricity, TV and more. Every data purchase automatically comes with a discount plus cashback.",
    "",
    "Open KaysPay to finish:",
    PLAY_STORE_URL,
  ]);

  return { subject: `${plainName === "there" ? "Finish setting up" : `${plainName}, finish setting up`} your KaysPay account`, html: shell(inner, "You're one step from finishing your KaysPay setup"), text };
}

/**
 * Lifecycle reminders (migration 197) -- same transactional category as
 * kycReminderEmail above: about the customer's OWN incomplete setup, never
 * gated on marketing consent. One function per stuck stage. Kept dash-free
 * (owner 2026-09-03) and, per the same guidance, no need to name specific
 * requirements the app itself will show.
 */
export function pinNotSetReminderEmail(firstName: string): { subject: string; html: string; text: string } {
  const name = firstName && firstName.trim() ? esc(firstName.trim()) : "there";
  const plainName = firstName && firstName.trim() ? firstName.trim() : "there";

  const inner = `
    <tr><td style="padding:30px 28px 6px;">
      <h1 style="margin:0 0 14px;font-size:21px;color:${INK};font-weight:800;">One step left, ${name}</h1>
      <p style="margin:0 0 14px;font-size:15px;color:${INK};line-height:1.65;">Your email is verified, but you haven't set your transaction PIN yet. It's the last step before your account is ready.</p>
      <p style="margin:0 0 18px;font-size:15px;color:${INK};line-height:1.65;">It takes under a minute and keeps your wallet secure. Once it's set, you can fund your wallet and start paying for airtime, data, electricity, TV and more.</p>
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
    "Your email is verified, but you haven't set your transaction PIN yet. It's the last step before your account is ready.",
    "",
    "It takes under a minute and keeps your wallet secure. Once it's set, you can fund your wallet and start paying for airtime, data, electricity, TV and more.",
    "",
    "Open KaysPay to finish:",
    PLAY_STORE_URL,
  ]);

  return { subject: `${plainName === "there" ? "Set your PIN to finish setting up" : `${plainName}, set your PIN to finish setting up`} KaysPay`, html: shell(inner, "One quick step left to secure your account"), text };
}

export function kycVerifiedNotFundedReminderEmail(firstName: string): { subject: string; html: string; text: string } {
  const name = firstName && firstName.trim() ? esc(firstName.trim()) : "there";
  const plainName = firstName && firstName.trim() ? firstName.trim() : "there";

  const inner = `
    <tr><td style="padding:30px 28px 6px;">
      <h1 style="margin:0 0 14px;font-size:21px;color:${INK};font-weight:800;">You're verified, ${name}</h1>
      <p style="margin:0 0 14px;font-size:15px;color:${INK};line-height:1.65;">Your identity has been verified. The only thing left is funding your wallet.</p>
      <p style="margin:0 0 18px;font-size:15px;color:${INK};line-height:1.65;">Once you do, you can pay for airtime, data, electricity, TV and more right from the app. Every data purchase automatically comes with a discount plus cashback.</p>
    </td></tr>
    <tr><td style="padding:6px 28px 30px;">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td style="background:${GREEN};border-radius:10px;">
          <a href="${PLAY_STORE_URL}" style="display:inline-block;padding:13px 22px;font-size:15px;font-weight:800;color:#ffffff;text-decoration:none;">Fund your wallet →</a>
        </td>
      </tr></table>
      <p style="margin:16px 0 0;font-size:12px;color:${MUTED};line-height:1.5;">Or open this link on your phone: <a href="${PLAY_STORE_URL}" style="color:${ACCENT};text-decoration:none;">${PLAY_STORE_URL}</a></p>
    </td></tr>`;

  const text = textShell([
    `You're verified, ${plainName}`,
    "",
    "Your identity has been verified. The only thing left is funding your wallet.",
    "",
    "Once you do, you can pay for airtime, data, electricity, TV and more right from the app. Every data purchase automatically comes with a discount plus cashback.",
    "",
    "Open KaysPay to fund your wallet:",
    PLAY_STORE_URL,
  ]);

  return { subject: `${plainName === "there" ? "You're verified" : `${plainName}, you're verified`}. Fund your wallet to get started`, html: shell(inner, "You're verified. Just fund your wallet to get started"), text };
}

export function fundedNotPurchasedReminderEmail(firstName: string): { subject: string; html: string; text: string } {
  const name = firstName && firstName.trim() ? esc(firstName.trim()) : "there";
  const plainName = firstName && firstName.trim() ? firstName.trim() : "there";

  const inner = `
    <tr><td style="padding:30px 28px 6px;">
      <h1 style="margin:0 0 14px;font-size:21px;color:${INK};font-weight:800;">Your wallet is ready, ${name}</h1>
      <p style="margin:0 0 14px;font-size:15px;color:${INK};line-height:1.65;">You've funded your wallet, but haven't made a purchase yet.</p>
      <p style="margin:0 0 18px;font-size:15px;color:${INK};line-height:1.65;">Buy airtime, data, pay bills and more right from the app. Every data purchase automatically comes with a discount plus cashback.</p>
    </td></tr>
    <tr><td style="padding:6px 28px 30px;">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td style="background:${GREEN};border-radius:10px;">
          <a href="${PLAY_STORE_URL}" style="display:inline-block;padding:13px 22px;font-size:15px;font-weight:800;color:#ffffff;text-decoration:none;">Open KaysPay →</a>
        </td>
      </tr></table>
      <p style="margin:16px 0 0;font-size:12px;color:${MUTED};line-height:1.5;">Or open this link on your phone: <a href="${PLAY_STORE_URL}" style="color:${ACCENT};text-decoration:none;">${PLAY_STORE_URL}</a></p>
    </td></tr>`;

  const text = textShell([
    `Your wallet is ready, ${plainName}`,
    "",
    "You've funded your wallet, but haven't made a purchase yet.",
    "",
    "Buy airtime, data, pay bills and more right from the app. Every data purchase automatically comes with a discount plus cashback.",
    "",
    "Open KaysPay:",
    PLAY_STORE_URL,
  ]);

  return { subject: `${plainName === "there" ? "Your wallet is funded" : `${plainName}, your wallet is funded`}. Make your first purchase`, html: shell(inner, "Your wallet is funded. Time for your first purchase"), text };
}

/**
 * One-off, incident-specific notice for a customer whose purchase failed
 * during a real outage (2026-09-03) and has since been resolved. Not part
 * of the automated reminder system -- sent manually, once, to the small
 * number of real customers actually affected. Deliberately doesn't name the
 * provider or dwell on what broke.
 */
/** "₦220", "₦220 and ₦300", or "₦220, ₦300 and ₦150" for 3+. */
function joinNairaAmounts(amountsNgn: number[]): string {
  const formatted = amountsNgn.map((n) => `₦${n.toLocaleString("en-NG")}`);
  if (formatted.length === 1) return formatted[0];
  return `${formatted.slice(0, -1).join(", ")} and ${formatted[formatted.length - 1]}`;
}

export function serviceRestoredEmail(
  firstName: string,
  refundedAmountsNgn?: number[],
): { subject: string; html: string; text: string } {
  const name = firstName && firstName.trim() ? esc(firstName.trim()) : "there";
  const plainName = firstName && firstName.trim() ? firstName.trim() : "there";
  const plural = !!refundedAmountsNgn && refundedAmountsNgn.length > 1;
  const openingLine = refundedAmountsNgn && refundedAmountsNgn.length
    ? `${plural ? "A couple of purchases" : "A purchase"} you tried earlier didn't go through due to a brief network delay. Your ${esc(joinNairaAmounts(refundedAmountsNgn))} ${plural ? "have" : "has"} been refunded immediately and ${plural ? "are" : "is"} already back in your wallet.`
    : "A purchase you tried earlier didn't go through due to a brief network delay. Your money was refunded immediately and is already back in your wallet.";
  const openingLineText = refundedAmountsNgn && refundedAmountsNgn.length
    ? `${plural ? "A couple of purchases" : "A purchase"} you tried earlier didn't go through due to a brief network delay. Your ${joinNairaAmounts(refundedAmountsNgn)} ${plural ? "have" : "has"} been refunded immediately and ${plural ? "are" : "is"} already back in your wallet.`
    : "A purchase you tried earlier didn't go through due to a brief network delay. Your money was refunded immediately and is already back in your wallet.";

  const inner = `
    <tr><td style="padding:30px 28px 6px;">
      <h1 style="margin:0 0 14px;font-size:21px;color:${INK};font-weight:800;">Your refund is confirmed, ${name}</h1>
      <p style="margin:0 0 14px;font-size:15px;color:${INK};line-height:1.65;">${openingLine}</p>
      <p style="margin:0 0 18px;font-size:15px;color:${INK};line-height:1.65;">Everything is working normally now. You can go ahead and complete your purchase.</p>
    </td></tr>
    <tr><td style="padding:6px 28px 30px;">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td style="background:${GREEN};border-radius:10px;">
          <a href="${PLAY_STORE_URL}" style="display:inline-block;padding:13px 22px;font-size:15px;font-weight:800;color:#ffffff;text-decoration:none;">Open KaysPay →</a>
        </td>
      </tr></table>
      <p style="margin:16px 0 0;font-size:12px;color:${MUTED};line-height:1.5;">Or open this link on your phone: <a href="${PLAY_STORE_URL}" style="color:${ACCENT};text-decoration:none;">${PLAY_STORE_URL}</a></p>
    </td></tr>`;

  const text = textShell([
    `Your refund is confirmed, ${plainName}`,
    "",
    openingLineText,
    "",
    "Everything is working normally now. You can go ahead and complete your purchase.",
    "",
    "Open KaysPay:",
    PLAY_STORE_URL,
  ]);

  return { subject: "Your refund is confirmed — try again", html: shell(inner, "Your refund is confirmed and everything is working again"), text };
}
