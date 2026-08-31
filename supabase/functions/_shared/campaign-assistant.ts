export type CampaignSegment =
  | "registered_not_verified"
  | "verified_kyc_incomplete"
  | "kyc_completed_not_funded"
  | "funded_not_purchased"
  | "inactive";

export interface SegmentInsight { segment: CampaignSegment; count: number }
export interface CampaignDraft {
  name: string;
  subject: string;
  previewText: string;
  textBody: string;
  htmlBody: string;
  segment: CampaignSegment;
  inactivityDays: number | null;
  rationale: string;
  audienceCount: number;
  heading: string;
  body: string;
  cta: string;
  appUrl: string;
}
export interface CampaignCopyOverride {
  segment: CampaignSegment; subject: string; heading: string; body: string;
  cta: string; rationale: string;
}

const PRIORITY: CampaignSegment[] = [
  "kyc_completed_not_funded", "funded_not_purchased", "verified_kyc_incomplete",
  "registered_not_verified", "inactive",
];

const COPY: Record<CampaignSegment, { label: string; subject: string; heading: string; body: string; cta: string; path: string }> = {
  registered_not_verified: { label: "registered customers awaiting email verification", subject: "Complete your KaysPay account", heading: "You’re one step away", body: "Verify your email to secure your account and continue setting up KaysPay.", cta: "Verify my email", path: "email-verification" },
  verified_kyc_incomplete: { label: "verified customers with incomplete KYC", subject: "Finish setting up your KaysPay account", heading: "Let’s finish your account setup", body: "Complete your identity verification to unlock the KaysPay services available to you.", cta: "Continue verification", path: "kyc" },
  kyc_completed_not_funded: { label: "KYC-complete customers who have not funded", subject: "Your KaysPay wallet is ready", heading: "Ready when you are", body: "Your account setup is complete. Fund your wallet when you’re ready to start using KaysPay.", cta: "Fund my wallet", path: "fund-wallet" },
  funded_not_purchased: { label: "funded customers awaiting their first purchase", subject: "Make your first KaysPay purchase", heading: "Put your wallet to work", body: "Your wallet is funded. You can now buy airtime or data and pay supported bills from KaysPay.", cta: "Explore KaysPay", path: "home" },
  inactive: { label: "inactive opted-in customers", subject: "See what’s waiting in KaysPay", heading: "Welcome back", body: "Your KaysPay account is ready whenever you need it. Open the app to continue where you stopped.", cta: "Open KaysPay", path: "home" },
};

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]!));
}

function chooseSegment(insights: SegmentInsight[], prompt: string): SegmentInsight {
  const normalized = prompt.toLowerCase();
  const intentPatterns: Array<[CampaignSegment, RegExp]> = [
    ["registered_not_verified", /email\s*(verification|verify)|unverified|confirm\s*(their|the)?\s*email/],
    ["verified_kyc_incomplete", /\bkyc\b|identity\s*verification|verify\s*(their|the)?\s*identity/],
    ["kyc_completed_not_funded", /not\s*funded|before\s*funding|fund\s*(their|the)?\s*wallet|wallet\s*funding/],
    ["funded_not_purchased", /first\s*purchase|not\s*purchased|buy\s*(airtime|data)|pay\s*(a|their)?\s*bill/],
    ["inactive", /inactive|dormant|come\s*back|re-?engage|stopped\s*using/],
  ];
  const explicit = PRIORITY.find((segment) => normalized.includes(segment.replaceAll("_", " ")));
  const requested = explicit ?? intentPatterns.find(([, pattern]) => pattern.test(normalized))?.[0];
  if (requested) return insights.find((item) => item.segment === requested) ?? { segment: requested, count: 0 };
  return [...insights].sort((a, b) => (b.count - a.count) || (PRIORITY.indexOf(a.segment) - PRIORITY.indexOf(b.segment)))[0]
    ?? { segment: "kyc_completed_not_funded", count: 0 };
}

export function generateCampaignDraft(insights: SegmentInsight[], prompt: string,override?:CampaignCopyOverride): CampaignDraft {
  const selected = override
    ? insights.find(item=>item.segment===override.segment)??{segment:override.segment,count:0}
    : chooseSegment(insights, prompt);
  const base = COPY[selected.segment];
  const copy = override ? {...base,subject:override.subject,heading:override.heading,body:override.body,cta:override.cta} : base;
  const appUrl = `https://kayspay.com.ng/${copy.path}`;
  const previewText = copy.body;
  const htmlBody = `<!doctype html><html><body style="margin:0;background:#f4f7f5;font-family:Arial,sans-serif;color:#163226"><div style="display:none;max-height:0;overflow:hidden">${esc(previewText)}</div><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f7f5;padding:32px 12px"><tr><td align="center"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#ffffff;border-radius:16px;overflow:hidden"><tr><td style="background:#103d27;padding:24px 32px;color:#ffffff;font-size:22px;font-weight:700">KaysPay</td></tr><tr><td style="padding:38px 32px"><h1 style="margin:0 0 16px;font-size:28px;line-height:1.2;color:#103d27">${esc(copy.heading)}</h1><p style="margin:0 0 26px;font-size:16px;line-height:1.65;color:#455b50">${esc(copy.body)}</p><a href="${esc(appUrl)}" style="display:inline-block;background:#198754;color:#ffffff;text-decoration:none;padding:14px 22px;border-radius:9px;font-weight:700">${esc(copy.cta)}</a><p style="margin:28px 0 0;font-size:12px;line-height:1.5;color:#7b8b83">For your security, KaysPay will never ask for your PIN, password, or OTP by email.</p></td></tr></table></td></tr></table></body></html>`;
  return {
    name: `AI recovery · ${copy.label} · ${new Date().toISOString().slice(0, 10)}`,
    subject: copy.subject,
    previewText,
    textBody: `${copy.heading}\n\n${copy.body}\n\n${copy.cta}: ${appUrl}\n\nFor your security, KaysPay will never ask for your PIN, password, or OTP by email.`,
    htmlBody,
    segment: selected.segment,
    inactivityDays: selected.segment === "inactive" ? 30 : null,
    rationale: override?.rationale??`${selected.count.toLocaleString()} consent-eligible ${copy.label} currently form the strongest available recovery opportunity. The message uses one clear next action and avoids financial promises or sensitive information.`,
    audienceCount: selected.count,
    heading: copy.heading,
    body: copy.body,
    cta: copy.cta,
    appUrl,
  };
}
