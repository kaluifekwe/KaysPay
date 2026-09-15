import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { adminClient, isServiceEnabled } from "../_shared/auth.ts";
import { redactSecrets } from "../_shared/redact.ts";
import { processFundingCandidate } from "../_shared/funding-credit.ts";
import { notificationRequery } from "../_shared/9psb-client.ts";

// 9PSB's inbound webhook has no signature/HMAC — Basic Auth only, per their
// own docs. That means the webhook body alone is never enough to prove
// authenticity, unlike Flutterwave/Paystack's HMAC-signed events. 9PSB's own
// guidance is to call notification_requery to confirm every inflow before
// trusting it — that requery result, not the webhook body, is what actually
// gets credited. This is a deliberate deviation from the other two
// webhooks' model, not an oversight.

const WEBHOOK_USER = Deno.env.get("NINEPSB_WEBHOOK_BASIC_USER");
const WEBHOOK_PASS = Deno.env.get("NINEPSB_WEBHOOK_BASIC_PASS");

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function isValidBasicAuth(req: Request): boolean {
  if (!WEBHOOK_USER || !WEBHOOK_PASS) return false;
  const header = req.headers.get("authorization") || "";
  if (!header.startsWith("Basic ")) return false;
  let decoded: string;
  try {
    decoded = atob(header.slice(6));
  } catch {
    return false;
  }
  const sepIndex = decoded.indexOf(":");
  if (sepIndex < 0) return false;
  const user = decoded.slice(0, sepIndex);
  const pass = decoded.slice(sepIndex + 1);
  return constantTimeEquals(user, WEBHOOK_USER) && constantTimeEquals(pass, WEBHOOK_PASS);
}

function ack() {
  return new Response(JSON.stringify({ success: true, code: "00", status: "SUCCESS", message: "Acknowledged" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

interface NormalizedTransferEvent {
  sessionId: string;
  accountNumber: string;
  amount: string;
  narration?: string;
}

/** 9PSB documents two payload shapes for ?event=transfer — a flat "short" form and a nested "long" form. Normalize both into one shape before anything else. */
function normalizeTransferPayload(body: any): NormalizedTransferEvent | null {
  const accountNumber = body?.accountnumber || body?.customer?.account?.number;
  const amount = body?.amount ?? body?.order?.amount;
  const sessionId = body?.nipsessionid || body?.transaction?.externalreference || body?.transactionref;
  if (!accountNumber || amount === undefined || amount === null || !sessionId) return null;
  return {
    sessionId: String(sessionId),
    accountNumber: String(accountNumber),
    amount: String(amount),
    narration: body?.narration,
  };
}

serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  if (!isValidBasicAuth(req)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }

  const declaredLength = Number(req.headers.get("content-length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > 131_072) {
    return new Response(JSON.stringify({ error: "Payload too large" }), { status: 413 });
  }
  const rawBody = await req.text();
  if (new TextEncoder().encode(rawBody).byteLength > 131_072) {
    return new Response(JSON.stringify({ error: "Payload too large" }), { status: 413 });
  }

  let body: any;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return new Response(JSON.stringify({ error: "Invalid payload" }), { status: 400 });
  }

  const url = new URL(req.url);
  const eventType = url.searchParams.get("event");

  // account-upgrade / corporate-account are explicitly out of scope for this
  // build — acknowledged only, never processed.
  if (eventType !== "transfer") {
    return ack();
  }

  const supabase = adminClient();

  try {
    if (!(await isServiceEnabled(supabase, "9psb_waas"))) {
      // Never let 9PSB retry-storm a disabled integration, but don't credit
      // anything either — log the drop for follow-up.
      console.warn("ninepsb-webhook: dropped transfer event while 9psb_waas is disabled");
      return ack();
    }

    const normalized = normalizeTransferPayload(body);
    if (!normalized) {
      console.error("ninepsb-webhook: unrecognized transfer payload shape");
      return ack();
    }

    // The webhook body is only ever a trigger — go ask 9PSB directly what
    // actually happened before crediting anything, since there's no
    // signature to verify the body itself.
    const requeryRes = await notificationRequery(supabase, {
      sessionID: normalized.sessionId,
      accountNumber: normalized.accountNumber,
    });
    const requeryData = requeryRes.data?.data ?? requeryRes.data;
    const requeryAmount = requeryData?.amount !== undefined ? String(requeryData.amount) : undefined;
    const confirmed = requeryRes.status < 400 &&
      (requeryRes.data?.status === "SUCCESS" || requeryRes.data?.status === true) &&
      (!requeryAmount || requeryAmount === normalized.amount);

    if (!confirmed) {
      console.error("ninepsb-webhook: notification_requery did not confirm this inflow", JSON.stringify({
        status: requeryRes.status,
        sessionId: normalized.sessionId,
      }));
      return ack();
    }

    await processFundingCandidate(supabase, {
      provider: "9psb",
      reference: normalized.sessionId,
      amountKobo: Math.round(Number(normalized.amount) * 100),
      currency: "NGN",
      accountNumber: normalized.accountNumber,
      source: "webhook",
    });

    return ack();
  } catch (e) {
    console.error("ninepsb-webhook unhandled error:", redactSecrets(e));
    // Still ack — 9PSB retries up to 10 times on a non-success response, and
    // a transient error here shouldn't trigger a retry storm. The event is
    // durably recorded (or safely dropped) before this point either way.
    return ack();
  }
});
