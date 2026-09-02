import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  adminClient,
  enforceRateLimit,
  getAuthUser,
  readJsonBody,
  RequestBodyError,
} from "../_shared/auth.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_VALUE = /^[A-Za-z0-9._+-]{1,32}$/;
const SAFE_SOURCE = /^[A-Za-z0-9._-]{1,64}$/;
const SAFE_CODE = /^[a-z0-9_]{2,64}$/;
const LOCALE = /^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})?$/;
const EVENTS = new Set([
  "app_opened", "onboarding_started", "onboarding_slide_viewed", "onboarding_skipped",
  "registration_started", "registration_validation_failed", "registration_submitted",
  "account_created", "email_verification_started", "email_verification_failed", "email_verified",
  "email_verification_deferred",
  "pin_setup_completed", "pin_setup_failed", "biometric_offer_completed", "home_viewed", "kyc_viewed", "kyc_started", "kyc_failed",
  "kyc_completed", "funding_viewed", "funding_started", "funding_failed",
  "first_funding_completed", "first_purchase_completed",
  // Started/failed abandonment tracking for the 4 purchase flows that
  // previously had none at all (see analytics.service.ts's AnalyticsEventType
  // for the full reasoning, including why crypto_buy has no _completed).
  "crypto_buy_started", "crypto_buy_failed",
  "foreign_number_started", "foreign_number_failed", "foreign_number_completed",
  "nin_services_started", "nin_services_failed", "nin_services_completed",
  "esim_started", "esim_failed", "esim_completed",
  // Same "no completed" reasoning as crypto_buy: success is already visible
  // via the transactions table + first_purchase_completed. What was missing
  // was any trace of a purchase that failed BEFORE a transaction row ever
  // existed (validation/catalog-staleness failures) -- see vtu-purchase's
  // resolvePurchase, which returns success:false without ever calling
  // debit_for_service.
  "data_started", "data_failed",
  "airtime_started", "airtime_failed",
  "electricity_started", "electricity_failed",
  "tv_started", "tv_failed",
]);
const OUTCOMES = new Set(["view", "started", "completed", "failed", "skipped", "deferred"]);
const PLATFORMS = new Set(["android", "ios", "web", "unknown"]);
const NETWORKS = new Set(["wifi", "cellular", "offline", "unknown"]);
const METADATA_KEYS = new Set(["slide_index", "entry_point", "verification_method", "funding_method"]);

type InputEvent = {
  event_id?: unknown; session_id?: unknown; event_type?: unknown; outcome?: unknown;
  occurred_at?: unknown; failure_code?: unknown; metadata?: unknown;
};
type Body = {
  installation_id?: unknown; events?: unknown; app_version?: unknown; build_number?: unknown;
  platform?: unknown; os_major?: unknown; network_type?: unknown; locale?: unknown;
  acquisition_source?: unknown;
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders(), "Content-Type": "application/json" } });
}

function optionalString(value: unknown, pattern: RegExp): string | null {
  if (value === undefined || value === null || value === "") return null;
  return typeof value === "string" && pattern.test(value) ? value : "INVALID";
}

function safeMetadata(value: unknown): Record<string, string | number | boolean> | null {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const result: Record<string, string | number | boolean> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (!METADATA_KEYS.has(key) || !["string", "number", "boolean"].includes(typeof item)) return null;
    if (typeof item === "string" && (item.length > 64 || !SAFE_SOURCE.test(item))) return null;
    if (typeof item === "number" && (!Number.isInteger(item) || Math.abs(item) > 1000)) return null;
    result[key] = item as string | number | boolean;
  }
  return result;
}

function trustedCountry(req: Request): string | null {
  // Supabase's hosted edge may forward Cloudflare's country code. Treat it as
  // optional and never retain the source IP. Local/dev requests simply store null.
  const value = req.headers.get("cf-ipcountry")?.toUpperCase() ?? "";
  return /^[A-Z]{2}$/.test(value) && value !== "XX" ? value : null;
}

serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const body = await readJsonBody<Body>(req, 16_384);
    if (typeof body.installation_id !== "string" || !UUID.test(body.installation_id)) return json({ error: "Invalid installation" }, 400);
    if (!Array.isArray(body.events) || body.events.length < 1 || body.events.length > 20) return json({ error: "Events must contain 1 to 20 items" }, 400);

    const appVersion = optionalString(body.app_version, SAFE_VALUE);
    const buildNumber = optionalString(body.build_number, SAFE_VALUE);
    const locale = optionalString(body.locale, LOCALE);
    const source = optionalString(body.acquisition_source, SAFE_SOURCE);
    const platform = body.platform === undefined ? null : typeof body.platform === "string" && PLATFORMS.has(body.platform) ? body.platform : "INVALID";
    const network = body.network_type === undefined ? null : typeof body.network_type === "string" && NETWORKS.has(body.network_type) ? body.network_type : "INVALID";
    const osMajor = body.os_major === undefined || body.os_major === null ? null : Number(body.os_major);
    if ([appVersion, buildNumber, locale, source, platform, network].includes("INVALID") ||
        (osMajor !== null && (!Number.isInteger(osMajor) || osMajor < 7 || osMajor > 100))) {
      return json({ error: "Invalid analytics context" }, 400);
    }

    const now = Date.now();
    const rows = [];
    const countryCode = trustedCountry(req);
    for (const raw of body.events as InputEvent[]) {
      const occurred = typeof raw.occurred_at === "string" ? new Date(raw.occurred_at) : null;
      const metadata = safeMetadata(raw.metadata);
      const failureCode = optionalString(raw.failure_code, SAFE_CODE);
      if (typeof raw.event_id !== "string" || !UUID.test(raw.event_id) ||
          typeof raw.session_id !== "string" || !UUID.test(raw.session_id) ||
          typeof raw.event_type !== "string" || !EVENTS.has(raw.event_type) ||
          (raw.outcome !== undefined && raw.outcome !== null && (typeof raw.outcome !== "string" || !OUTCOMES.has(raw.outcome))) ||
          !occurred || Number.isNaN(occurred.getTime()) || occurred.getTime() < now - 7 * 86400000 || occurred.getTime() > now + 300000 ||
          metadata === null || failureCode === "INVALID") {
        return json({ error: "Invalid analytics event" }, 400);
      }
      rows.push({
        event_id: raw.event_id, installation_id: body.installation_id, session_id: raw.session_id,
        event_type: raw.event_type, outcome: raw.outcome ?? null, occurred_at: occurred.toISOString(),
        app_version: appVersion, build_number: buildNumber, platform, os_major: osMajor,
        network_type: network, locale, country_code: countryCode, region_code: null,
        acquisition_source: source, failure_code: failureCode, metadata,
      });
    }

    const db = adminClient();
    const user = await getAuthUser(req);
    const rate = await enforceRateLimit(db, "analytics_ingest", body.installation_id, 30, 60, user?.id ?? null);
    if (!rate.allowed) return json({ error: "Too many analytics requests", retry_after_seconds: rate.retryAfterSeconds }, 429);

    const { error: registrationError } = await db.rpc("register_analytics_installation", {
      p_installation_id: body.installation_id, p_subject_id: user?.id ?? null,
    });
    if (registrationError) return json({ error: "Could not register analytics installation" }, 409);

    const linkedRows = rows.map((row) => ({ ...row, subject_id: user?.id ?? null }));
    const { data, error } = await db.from("onboarding_analytics_events")
      .upsert(linkedRows, { onConflict: "event_id", ignoreDuplicates: true }).select("event_id");
    if (error) return json({ error: "Could not record analytics" }, 500);
    return json({ success: true, accepted: data?.length ?? 0 });
  } catch (error) {
    if (error instanceof RequestBodyError) return json({ error: error.message }, error.status);
    console.error("analytics-ingest failed");
    return json({ error: "Could not record analytics" }, 500);
  }
});
