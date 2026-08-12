import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import {
  adminClient,
  consumeAuthToken,
  enforceRateLimit,
  getAuthUser,
  isDeviceSessionAllowed,
  isServiceEnabled,
  readJsonBody,
  RequestBodyError,
} from "../_shared/auth.ts";
import { confirmServiceRefund } from "../_shared/service-refund.ts";
import {
  AIRTIME_MAX,
  AIRTIME_MIN,
  BILL_MAX,
  BILL_MIN,
  ELECTRICITY_PROVIDERS,
  EXAM_PIN_TYPES,
  KOBO,
  NetworkProvider,
  resolveVtunaijaDiscoId,
  TVServiceProvider,
  VALID_NETWORKS,
  VTUNAIJA_CABLE_IDS,
  VTUNAIJA_EXAM_IDS,
  VTUNAIJA_NETWORK_IDS,
} from "../_shared/vtu-catalog.ts";
import {
  callVTUNaija,
  isVtuNaijaConfigured,
  normalizeCableTVSmartcardVerification,
  normalizeElectricityMeterVerification,
  normalizeVTUNaijaResult,
  VTUNaijaError,
  verifyCableTVSmartcard,
  verifyElectricityMeter,
  vtunaijaOutcome,
} from "../_shared/vtunaija-client.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function newRequestId() {
  // VTU.ng caps request_id at 50 chars 鈥?this is well within that, and
  // doubles as our own idempotency key (one id, one meaning, everywhere).
  return `ksp_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
}

// Translates VTUnaija's own failure message into a specific, actionable
// reason when we recognize the pattern 鈥?an allowlist with a safe generic
// fallback, NOT a pass-through of raw provider text. Some VTUnaija messages
// aren't fit for display (e.g. the bare "failed, failed, failed. Something
// went wrong" seen on a live purchase) and must never reach the user as-is.
function friendlyVtunaijaFailureMessage(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower.includes("owing") && lower.includes("airtime")) {
    return "This plan can't be delivered if you owe airtime on this network. Clear any airtime debt first, or choose a different plan.";
  }
  if (lower.includes("does not exist") || lower.includes("refresh your plan")) {
    return "This plan is temporarily unavailable. Please refresh and choose a different plan.";
  }
  return "Purchase failed. You were not charged.";
}

type Provider = "vtunaija";

const CATALOG_STALE_MS = 30 * 60 * 1000;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const CRON_SECRET = Deno.env.get("CRON_SECRET");

// A stale catalog (provider_seen_at older than 30 min 鈥?normally caused by
// the 5-min sync cron missing a beat, e.g. job-lock contention or one
// transient provider fetch failure) used to fail the purchase outright with
// a plain "Failed" screen and no transaction created, even though the user
// was never actually charged. Since that on-demand sync is exactly what the
// scheduled cron already does, triggering it inline here first (same
// refresh path, just called synchronously instead of waiting for the next
// tick) resolves almost all of these without ever surfacing to the user.
// Falls through to a real CATALOG_STALE only if the provider call itself
// fails or the sync still can't produce a fresh row.
async function refreshVtunaijaCatalogInline(
  fn: "vtunaija-data-catalog" | "vtunaija-cabletv-catalog" | "vtunaija-exam-catalog",
): Promise<boolean> {
  if (!SUPABASE_URL || !CRON_SECRET) return false;
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/${fn}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-cron-secret": CRON_SECRET },
      body: JSON.stringify({ refresh: true }),
    });
    if (!res.ok) return false;
    const body = await res.json();
    return body?.success === true;
  } catch {
    return false; // the regular reconcile/cron path remains the backstop
  }
}

/**
 * Resolve the trusted price + provider payload for a purchase request.
 * `amount` is in KOBO (used to debit the wallet). Amounts inside
 * `providerPayload` are in NAIRA because both providers expect naira.
 * Throws a string error code for invalid requests.
 *
 * Provider routing (as of the VTUnaija migration, 2026-08-03):
 *   - airtime -> VTUnaija (/topup/). Moved off VTU.ng.
 *   - data -> VTUnaija (/data/, NOT /internetbundles/ 鈥?that endpoint needed
 *     an unconfirmed `account_Id` field; /data/ needs no such field and
 *     returns the identical success wording, confirmed the right one to use).
 *     Moved off VTU.ng. Catalog prices come from vtunaija_data_catalog.
 *   - electricity -> VTUnaija (/billpayment/). DISCO id resolved via
 *     vtunaija_electricity_catalog (a live-synced name lookup, not a
 *     hardcoded numeric code 鈥?see VTUNAIJA_ELECTRICITY_NAME_MAP). Moved off
 *     VTUAfrica. The one-time prepaid meter token is persisted into
 *     transaction metadata on success, same as the VTUAfrica branch used to.
 *   - tv -> VTUnaija (/cablesub/). Bouquet catalog is now fully dynamic
 *     (vtunaija_cabletv_catalog), replacing the old static TV_BOUQUETS map 鈥? *     the client (TVScreen.tsx) fetches bouquets live, same pattern as data.
 *     Moved off VTUAfrica.
 *   - exam_pin -> VTUnaija (/exam/), mirroring its six documented Exam IDs:
 *     WAEC, NECO, NABTEB, JAMB, WAEC Registration and NBAIS. Quantity is
 *     intentionally restricted to one until its multi-PIN response format is
 *     confirmed. Both the returned PIN and serial are persisted.
 *
 * VTU.ng's and VTUAfrica's client/reconcile/catalog code stays deployed but
 * unreferenced for airtime/data/electricity/TV 鈥?fast rollback if ever
 * needed, see supabase/ROLLBACK_VTUNAIJA.md.
 */
class PriceChangedError extends Error {
  constructor(public readonly currentAmountKobo: number) {
    super("PRICE_CHANGED");
  }
}

// Trims/caps an opaque display-only string before it's persisted into
// transaction metadata (e.g. the meter's verified customer name/address).
// Never used for any money decision 鈥?purely for receipts/History 鈥?but
// still capped and type-checked since it ultimately rides into HTML (the
// PDF receipt template) and a client-controlled field must never be trusted
// as-is.
function safeDisplayString(v: unknown, maxLen = 200): string | undefined {
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim();
  return trimmed ? trimmed.slice(0, maxLen) : undefined;
}

async function resolvePurchase(body: any, supabase: ReturnType<typeof adminClient>): Promise<{
  amount: number; // kobo
  txType: string;
  network: string;
  recipient: string | null;
  provider: Provider;
  endpoint: string;
  providerPayload: Record<string, unknown>;
  availability?: { network: string; familyKey: string; planId: string };
}> {
  const service = String(body?.service || "");

  switch (service) {
    case "airtime": {
      const network = String(body.network || "")
        .toLowerCase() as NetworkProvider;
      const amount = Number(body.amount); // kobo
      const phone = String(body.phone || "");
      if (!VALID_NETWORKS.includes(network)) throw "INVALID_NETWORK";
      if (!/^0\d{10}$/.test(phone)) throw "INVALID_PHONE";
      if (
        !Number.isInteger(amount) || amount < AIRTIME_MIN ||
        amount > AIRTIME_MAX
      ) throw "INVALID_AMOUNT";
      return {
        amount,
        txType: "airtime",
        network,
        recipient: phone,
        provider: "vtunaija",
        endpoint: "/topup/",
        providerPayload: {
          network: VTUNAIJA_NETWORK_IDS[network],
          mobile_number: phone,
          // Every documented example sends "true" regardless of the actual
          // recipient 鈥?treated as a required constant, not computed per
          // request. Confirm the real semantics with VTUnaija support before
          // relying on this at scale (tracked in the VTUnaija migration plan).
          Ported_number: "true",
          amount: amount / KOBO,
          airtime_type: "VTU",
        },
      };
    }

    case "data": {
      const network = String(body.network || "")
        .toLowerCase() as NetworkProvider;
      const phone = String(body.phone || "");
      const bundleId = String(body.bundle_id || "");
      if (!VALID_NETWORKS.includes(network)) throw "INVALID_NETWORK";
      if (!/^0\d{10}$/.test(phone)) throw "INVALID_PHONE";

      const bundleQuery = () =>
        supabase
          .from("vtunaija_data_catalog")
          .select("id, network, data_plan_id, family_key, reseller_kobo, available, provider_seen_at")
          .eq("id", bundleId)
          .eq("network", network)
          .eq("available", true)
          .maybeSingle();

      let { data: bundle } = await bundleQuery();
      if (!bundle) throw "INVALID_BUNDLE";
      if (new Date(bundle.provider_seen_at).getTime() < Date.now() - CATALOG_STALE_MS) {
        const refreshed = await refreshVtunaijaCatalogInline("vtunaija-data-catalog");
        if (refreshed) ({ data: bundle } = await bundleQuery());
        if (!bundle || new Date(bundle.provider_seen_at).getTime() < Date.now() - CATALOG_STALE_MS) {
          throw "CATALOG_STALE";
        }
      }
      // Admin-settable per-plan price (see migration 112) — same lookup
      // vtunaija-data-catalog uses to quote this plan to the client, so the
      // two always agree and the quoted_amount_kobo check below still works.
      const { data: priceOverride } = await supabase
        .from("vtu_plan_price_overrides")
        .select("price_kobo")
        .eq("provider", "vtunaija")
        .eq("network", network)
        .eq("plan_id", bundle.id)
        .maybeSingle();
      const amount = Number(priceOverride?.price_kobo ?? bundle.reseller_kobo);
      const quotedAmount = Number(body.quoted_amount_kobo);
      if (Number.isFinite(quotedAmount) && quotedAmount > 0 && quotedAmount !== amount) {
        throw new PriceChangedError(amount);
      }
      const { data: planEnabled, error: controlError } = await supabase.rpc("is_vtu_plan_enabled", {
        p_provider: "vtunaija",
        p_network: network,
        p_family_key: bundle.family_key,
        p_plan_id: bundle.id,
      });
      if (controlError) throw "AVAILABILITY_UNAVAILABLE";
      if (planEnabled !== true) throw "PLAN_DISABLED";
      return {
        amount,
        txType: "data",
        network,
        recipient: phone,
        provider: "vtunaija",
        availability: { network, familyKey: bundle.family_key, planId: bundle.id },
        endpoint: "/data/",
        providerPayload: {
          network: VTUNAIJA_NETWORK_IDS[network],
          mobile_number: phone,
          plan: bundle.data_plan_id,
          // Same unconfirmed-but-documented-default as airtime 鈥?see the
          // Ported_number comment in the airtime case above.
          Ported_number: "true",
        },
      };
    }

    case "electricity": {
      const biller = String(body.provider_id || "");
      const meter = String(body.meter_number || "");
      const amount = Number(body.amount); // kobo
      const type = body.type === "postpaid" ? "postpaid" : "prepaid";
      if (!ELECTRICITY_PROVIDERS.includes(biller)) throw "INVALID_PROVIDER";
      if (!/^\d{6,20}$/.test(meter)) throw "INVALID_METER";
      if (!Number.isInteger(amount) || amount < BILL_MIN || amount > BILL_MAX) {
        throw "INVALID_AMOUNT";
      }

      // Resolve the app's own DISCO id to VTUnaija's current numeric
      // disco_name code via the live-synced lookup 鈥?same helper
      // verify-electricity-meter uses, so a meter verified for a DISCO
      // always resolves to the identical code at purchase time.
      const discoId = await resolveVtunaijaDiscoId(supabase, biller);
      if (!discoId) throw "INVALID_PROVIDER";

      return {
        amount,
        txType: "bill",
        network: "N/A",
        recipient: meter,
        provider: "vtunaija",
        verificationProviderId: biller,
        endpoint: "/billpayment/",
        providerPayload: {
          disco_name: discoId,
          meter_number: meter,
          MeterType: type,
          amount: amount / KOBO,
        },
      };
    }

    case "tv": {
      const bouquetId = String(body.bouquet_id || "");
      const smartcard = String(body.smartcard_number || "");
      if (!/^\d{6,20}$/.test(smartcard)) throw "INVALID_SMARTCARD";

      const bouquetQuery = () =>
        supabase
          .from("vtunaija_cabletv_catalog")
          .select("provider, cabletv_plan_id, reseller_kobo, available, provider_seen_at")
          .eq("id", bouquetId)
          .eq("available", true)
          .maybeSingle();

      let { data: bouquet } = await bouquetQuery();
      if (!bouquet) throw "INVALID_BOUQUET";
      if (new Date(bouquet.provider_seen_at).getTime() < Date.now() - CATALOG_STALE_MS) {
        const refreshed = await refreshVtunaijaCatalogInline("vtunaija-cabletv-catalog");
        if (refreshed) ({ data: bouquet } = await bouquetQuery());
        if (!bouquet || new Date(bouquet.provider_seen_at).getTime() < Date.now() - CATALOG_STALE_MS) {
          throw "CATALOG_STALE";
        }
      }

      return {
        amount: Number(bouquet.reseller_kobo),
        txType: "bill",
        network: "N/A",
        recipient: smartcard,
        provider: "vtunaija",
        verificationProviderId: bouquet.provider,
        endpoint: "/cablesub/",
        providerPayload: {
          cablename: VTUNAIJA_CABLE_IDS[bouquet.provider as TVServiceProvider],
          smart_card_number: smartcard,
          cableplan: bouquet.cabletv_plan_id,
        },
      };
    }

    case "exam_pin": {
      const examId = String(body.exam_id || "");
      const quantity = Number(body.quantity);
      const exam = EXAM_PIN_TYPES[examId];
      if (!exam) throw "INVALID_EXAM_TYPE";
      if (!exam.quantityOptions.includes(quantity)) throw "INVALID_QUANTITY";

      const vtunaijaExamCode = VTUNAIJA_EXAM_IDS[examId];
      if (vtunaijaExamCode) {
        const examQuery = () => supabase
          .from("vtunaija_exam_catalog")
          .select("customer_kobo, available, requires_review, provider_seen_at")
          .eq("id", examId)
          .maybeSingle();
        let { data: liveExam, error: examError } = await examQuery();
        if (examError || !liveExam) throw "CATALOG_STALE";
        if (new Date(liveExam.provider_seen_at).getTime() < Date.now() - CATALOG_STALE_MS) {
          const refreshed = await refreshVtunaijaCatalogInline("vtunaija-exam-catalog");
          if (refreshed) ({ data: liveExam, error: examError } = await examQuery());
          if (examError || !liveExam || new Date(liveExam.provider_seen_at).getTime() < Date.now() - CATALOG_STALE_MS) {
            throw "CATALOG_STALE";
          }
        }
        if (liveExam.available !== true || liveExam.requires_review === true) throw "EXAM_UNAVAILABLE";
        const unitAmount = Number(liveExam.customer_kobo);
        if (!Number.isSafeInteger(unitAmount) || unitAmount <= 0) throw "CATALOG_STALE";
        const totalAmount = unitAmount * quantity;
        const quotedAmount = Number(body.quoted_amount_kobo);
        if (!Number.isSafeInteger(quotedAmount) || quotedAmount !== totalAmount) {
          throw new PriceChangedError(totalAmount);
        }
        return {
          amount: totalAmount,
          txType: "exam_pin",
          network: "N/A",
          recipient: null,
          provider: "vtunaija",
          endpoint: "/exam/",
          providerPayload: {
            // Sent as strings — VTUnaija's own docs show both quoted
            // ("exam_name": "2", "quantity": "1") even though exam_name is
            // numeric and quantity is a number internally here.
            exam_name: String(vtunaijaExamCode),
            quantity: String(quantity),
          },
        };
      }

      // Every app-visible exam must map to a documented VTUnaija Exam ID.
      // Fail closed if the catalog and routing table ever drift apart.
      throw "INVALID_EXAM_TYPE";
    }

    default:
      throw "UNKNOWN_SERVICE";
  }
}

// Turn the internal validation codes thrown by resolvePurchase into clear,
// user-facing sentences 鈥?the client shows this text directly, so it must
// never be a raw code like "INVALID_PHONE".
const VALIDATION_MESSAGES: Record<string, string> = {
  INVALID_NETWORK: "Please choose a valid network.",
  INVALID_PHONE: "Please enter a valid phone number.",
  INVALID_AMOUNT: "Please enter a valid amount.",
  INVALID_BUNDLE: "Please choose a valid data bundle.",
  PLAN_DISABLED: "This data bundle is temporarily unavailable. Please choose another plan.",
  AVAILABILITY_UNAVAILABLE: "Plan availability could not be verified. Please try again shortly.",
  CATALOG_STALE: "Prices are being refreshed. Please try again shortly.",
  INVALID_PROVIDER: "Please choose a valid provider.",
  INVALID_METER: "Please enter a valid meter number.",
  INVALID_BOUQUET: "Please choose a valid package.",
  INVALID_SMARTCARD: "Please enter a valid smartcard number.",
  INVALID_EXAM_TYPE: "Please choose a valid exam type.",
  INVALID_QUANTITY: "Please choose a valid quantity.",
  EXAM_UNAVAILABLE: "This Exam PIN is temporarily unavailable while its new provider price is reviewed.",
  INVALID_PROFILE_CODE: "Please enter your JAMB profile code.",
  UNKNOWN_SERVICE: "This service isn't available right now.",
};
function friendlyValidation(code: string): string {
  return VALIDATION_MESSAGES[code] ||
    "Please check your details and try again.";
}

console.info("[build] phase5-financial-controls-20260801");

serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  // 1. Authenticate from the JWT 鈥?never trust a client-sent user id.
  const user = await getAuthUser(req);
  if (!user) return json({ error: "Unauthorized" }, 401);

  let body: any;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    const e = error instanceof RequestBodyError
      ? error
      : new RequestBodyError(400, "Invalid request body");
    return json({ error: e.message }, e.status);
  }

  const supabase = adminClient();
  if (!(await isServiceEnabled(supabase, "vtu"))) {
    return json({
      success: false,
      error: "This service is temporarily unavailable. Please try again later.",
    }, 503);
  }
  if (!(await isDeviceSessionAllowed(req, supabase, user.id))) {
    return json({
      error: "This device session has been revoked. Please log in again.",
    }, 401);
  }

  const rate = await enforceRateLimit(
    supabase,
    "vtu_purchase",
    user.id,
    30,
    300,
    user.id,
  );
  if (!rate.allowed) {
    return json({
      success: false,
      error:
        "Too many purchase attempts. Please wait a few minutes and try again.",
      retry_after_seconds: rate.retryAfterSeconds,
    }, 429);
  }

  // 2. Require server-verified proof the PIN/biometric step-up just ran for
  // THIS request 鈥?a valid JWT alone is not enough to move money.
  let plan;
  try {
    plan = await resolvePurchase(body, supabase);
  } catch (code) {
    if (code instanceof PriceChangedError) {
      return json({
        success: false,
        code: "PRICE_CHANGED",
        current_amount: code.currentAmountKobo / KOBO,
        error: `The price changed to 鈧?{(code.currentAmountKobo / KOBO).toLocaleString("en-NG")}. Please confirm again.`,
      });
    }
    const validationCode = String(code);
    return json({ success: false, code: validationCode, error: friendlyValidation(validationCode) }, 400);
  }

  const requestId = String(body.idempotency_key || newRequestId());

  // Idempotency short-circuit 鈥?settle from an already-actioned request
  // BEFORE ever touching the PIN/biometric token. Previously the token was
  // consumed unconditionally on every call, and the idempotency check only
  // lived inside debit_for_service, called much later. That meant an
  // ordinary network retry (same idempotency key, e.g. one item in a bulk
  // send whose response got dropped) still burned a use of the shared
  // multi-use token even though nothing new was ever going to be charged 鈥?  // enough retries in one batch could exhaust the token mid-send and force
  // a fresh PIN entry for no real reason. Checking here first means a
  // retry of an already-resolved (or already in-flight) request costs
  // nothing: no token spent, no provider call repeated.
  const { data: existingTx } = await supabase
    .from("transactions")
    .select("id, status, amount_ngn, metadata")
    .eq("metadata->>idempotency_key", requestId)
    .maybeSingle();

  if (existingTx) {
    const md = (existingTx.metadata ?? {}) as Record<string, unknown>;
    if (existingTx.status === "completed") {
      return json({
        success: true,
        transaction_id: existingTx.id,
        order_id: md.order_id,
        token: md.token,
        pins: md.pins,
        amount: existingTx.amount_ngn,
      });
    }
    if (existingTx.status === "failed" || existingTx.status === "refunded") {
      return json({
        success: false,
        error: "This purchase already failed and was refunded. Please start a new purchase.",
      });
    }
    // Still 'pending' 鈥?genuinely ambiguous/in-flight from an earlier
    // attempt. Never resubmit the provider call for it; the reconcile
    // sweep is what settles this, same as everywhere else in this file.
    return json({
      success: true,
      pending: true,
      transaction_id: existingTx.id,
      message: "Your order is still processing. You'll be notified once it completes.",
    });
  }

  // A provider verification performed by our authenticated Edge Functions is
  // reusable for five minutes. This removes the duplicate provider call when
  // a customer verifies on the payment screen and immediately pays, while the
  // server-only table remains the source of truth (the mobile client cannot
  // manufacture a trusted verification).
  const verificationFreshSince = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  let verifiedTVCustomerName: string | null = null;
  let verifiedTVCurrentBouquet: string | null = null;
  let verifiedElectricityCustomerName: string | null = null;
  let verifiedElectricityCustomerAddress: string | null = null;
  if (body.service === "tv" || body.service === "electricity") {
    if (!isVtuNaijaConfigured()) {
      return json({
        success: false,
        error: body.service === "tv"
          ? "Smartcard verification isn't available right now."
          : "Meter verification isn't available right now.",
      }, 503);
    }

    const verificationProviderId = String(
      (plan as { verificationProviderId?: unknown }).verificationProviderId || "",
    );
    const verificationAccountNumber = String(plan.recipient || "");
    const { data: freshVerification } = await supabase
      .from("saved_billing_accounts")
      .select("customer_name, customer_address, last_verified_at")
      .eq("user_id", user.id)
      .eq("service", body.service)
      .eq("provider_id", verificationProviderId)
      .eq("account_number", verificationAccountNumber)
      .gte("last_verified_at", verificationFreshSince)
      .maybeSingle();

    if (freshVerification) {
      if (body.service === "tv") {
        verifiedTVCustomerName = freshVerification.customer_name;
      } else {
        verifiedElectricityCustomerName = freshVerification.customer_name;
        verifiedElectricityCustomerAddress = freshVerification.customer_address;
      }
    } else if (body.service === "tv") {
    try {
      const payload = plan.providerPayload as Record<string, unknown>;
      const verificationResult = await verifyCableTVSmartcard(
        String(payload.cablename || ""),
        String(payload.smart_card_number || ""),
      );
      const verified = normalizeCableTVSmartcardVerification(verificationResult);
      if (!verified.ok || !verified.customerName) {
        return json({
          success: false,
          error: "This smartcard number could not be verified for the selected TV provider.",
        }, 400);
      }
      verifiedTVCustomerName = verified.customerName;
      verifiedTVCurrentBouquet = verified.currentBouquet;

      const now = new Date().toISOString();
      const { error: saveError } = await supabase.from("saved_billing_accounts").upsert({
        user_id: user.id,
        service: "tv",
        provider_id: verificationProviderId,
        account_number: verificationAccountNumber,
        customer_name: verified.customerName,
        provider_customer_name: verified.customerName,
        last_verified_at: now,
        last_used_at: now,
      }, { onConflict: "user_id,service,provider_id,account_number" });
      if (saveError) console.error("Could not save fresh TV verification:", saveError.code);
    } catch {
      return json({
        success: false,
        error: "Could not verify this smartcard number right now. Please try again.",
      }, 503);
    }
    } else {
      try {
        const payload = plan.providerPayload as Record<string, unknown>;
        const verificationResult = await verifyElectricityMeter(
          String(payload.disco_name || ""),
          verificationAccountNumber,
        );
        const verified = normalizeElectricityMeterVerification(verificationResult);
        if (!verified.ok || !verified.customerName) {
          return json({
            success: false,
            error: "This meter number could not be verified for the selected electricity provider.",
          }, 400);
        }
        verifiedElectricityCustomerName = verified.customerName;
        verifiedElectricityCustomerAddress = verified.customerAddress;

        const now = new Date().toISOString();
        const { error: saveError } = await supabase.from("saved_billing_accounts").upsert({
          user_id: user.id,
          service: "electricity",
          provider_id: verificationProviderId,
          account_number: verificationAccountNumber,
          customer_name: verified.customerName,
          provider_customer_name: verified.customerName,
          customer_address: verified.customerAddress,
          last_verified_at: now,
          last_used_at: now,
        }, { onConflict: "user_id,service,provider_id,account_number" });
        if (saveError) console.error("Could not save fresh electricity verification:", saveError.code);
      } catch {
        return json({
          success: false,
          error: "Could not verify this meter number right now. Your wallet has not been debited.",
        }, 503);
      }
    }
  }

  const authorized = await consumeAuthToken(supabase, user.id, body.auth_token);
  if (!authorized) {
    return json({
      success: false,
      error: "Re-authorization required. Please try again.",
    }, 401);
  }

  if (!isVtuNaijaConfigured()) {
    return json({ error: "VTU provider not configured" }, 500);
  }

  // 3b. Duplicate guard (data + TV only). The telco/VTUAfrica rejects a repeat
  // of the SAME plan to the SAME recipient within a short window, which would
  // otherwise become a confusing debit -> provider-reject -> refund. Catch it
  // here and tell the user plainly. Airtime/electricity/exam allow legitimate
  // repeats, so they're excluded.
  if (body.service === "data" || body.service === "tv") {
    const dupSince = new Date(Date.now() - 3 * 60 * 1000).toISOString();
    const { data: recentSame } = await supabase
      .from("transactions")
      .select("metadata")
      .eq("user_id", user.id)
      .eq("type", plan.txType)
      .eq("recipient_phone", plan.recipient)
      .in("status", ["completed", "pending"])
      .gte("created_at", dupSince)
      .limit(5);
    const pp = plan.providerPayload as Record<string, unknown>;
    const isSamePlan = (recentSame ?? []).some((t) => {
      const req =
        ((t.metadata as Record<string, unknown>)?.request ?? {}) as Record<
          string,
          unknown
        >;
      return body.service === "data"
        ? req.network === pp.network && req.plan === pp.plan
        : req.cablename === pp.cablename && req.cableplan === pp.cableplan;
    });
    if (isSamePlan) {
      return json({
        success: false,
        error:
          "You just bought this plan for this number. Please wait a couple of minutes before buying it again.",
      });
    }
  }

  // 4. Atomically debit + create the pending transaction.
  const { data: txId, error: debitError } = await supabase.rpc(
    "debit_for_service",
    {
      p_user_id: user.id,
      p_amount: plan.amount,
      p_type: plan.txType,
      p_network: plan.network,
      p_recipient: plan.recipient,
      p_metadata: {
        service: body.service,
        request: plan.providerPayload,
        provider: plan.provider,
        provider_reference: requestId.replace(/[^a-zA-Z0-9]/g, ""),
      },
      p_idempotency_key: requestId,
    },
  );

  if (debitError) {
    const msg = debitError.message || "";
    // Expected business outcomes return 200 + success:false so the client
    // can read them directly; only genuine faults return non-2xx.
    if (msg.includes("INSUFFICIENT_FUNDS")) {
      return json({ success: false, error: "Insufficient balance" });
    }
    if (msg.includes("WALLET_NOT_FOUND")) {
      return json({ success: false, error: "Wallet not found" });
    }
    return json({ success: false, error: "Could not start transaction" }, 500);
  }

  // 4c. VTUnaija 鈥?airtime, data, electricity, TV, and (WAEC/NECO/NABTEB)
  // exam pins all route here now (JAMB and WAEC Verification/GCE stay on
  // VTUAfrica 鈥?see the Provider-routing doc comment above). Same
  // inline-await, never-background pattern as VTUAfrica above: the
  // EdgeRuntime.waitUntil incident (worker EarlyDropped right after
  // responding, killing an in-flight provider call and leaving a user
  // debited with no airtime delivered) means the provider call MUST be
  // fully awaited before this function ever responds.
  if (plan.provider === "vtunaija") {
    try {
      const result = await callVTUNaija(plan.endpoint, {
        ...plan.providerPayload,
        "request-id": requestId,
      });
      const outcome = vtunaijaOutcome(result);
      const normalized = normalizeVTUNaijaResult(result);

      if (outcome === "success") {
        const { error: completeError } = await supabase.rpc(
          "complete_service_transaction",
          { p_tx_id: txId, p_order_id: normalized.id ?? normalized.ident ?? null },
        );
        if (completeError) throw completeError;

        // Electricity's success response carries a one-time prepaid meter
        // token 鈥?never returned again after this response, so persist it
        // into the transaction's own metadata (same reasoning/shape as the
        // VTUAfrica electricity branch above) so receipts/History still work.
        const electricityToken: string | undefined = result?.token ?? result?.electricitytoken;

        // Exam pin success carries a one-time PIN + serial. VTUnaija's docs
        // only show a single pin/serial pair for quantity=1 鈥?the
        // multi-quantity delimiter format is UNCONFIRMED (VTUAfrica used
        // "<=>"), so this splits defensively on known delimiters and falls
        // back to the single raw string rather than ever guessing/losing a
        // PIN. Verify the real multi-quantity shape with a live test before
        // trusting this at quantity > 1.
        const pinRaw = normalized.pin ?? undefined;
        const pins = pinRaw
          ? (pinRaw.includes("<=>") ? pinRaw.split("<=>") : pinRaw.includes(",") ? pinRaw.split(",") : [pinRaw])
              .map((s: string) => s.trim())
              .filter(Boolean)
          : undefined;
        const serialRaw = normalized.serial ?? undefined;
        const serials = serialRaw
          ? (serialRaw.includes("<=>") ? serialRaw.split("<=>") : serialRaw.includes(",") ? serialRaw.split(",") : [serialRaw])
              .map((s: string) => s.trim())
              .filter(Boolean)
          : undefined;

        // Electricity: carry the meter's verified customer name/address
        // (checked client-side before payment 鈥?see
        // verify-electricity-meter) into the transaction's own metadata,
        // same as the token, so History can rebuild the full receipt later
        // without re-verifying. Purely opaque display strings 鈥?never used
        // for any money decision.
        const customerName = body.service === "electricity"
          ? safeDisplayString(verifiedElectricityCustomerName)
          : undefined;
        const customerAddress = body.service === "electricity"
          ? safeDisplayString(verifiedElectricityCustomerAddress)
          : undefined;

        if (electricityToken || pins || serials || body.service === "electricity" || body.service === "tv") {
          await supabase
            .from("transactions")
            .update({
              metadata: {
                service: body.service,
                request: plan.providerPayload,
                provider: plan.provider,
                idempotency_key: requestId,
                provider_reference: requestId.replace(/[^a-zA-Z0-9]/g, ""),
                ...(electricityToken ? { token: electricityToken } : {}),
                ...(pins ? { pins } : {}),
                ...(serials ? { serials } : {}),
                ...(body.service === "electricity" ? { provider_id: String(body.provider_id || "") } : {}),
                ...(customerName ? { customer_name: customerName } : {}),
                ...(customerAddress ? { customer_address: customerAddress } : {}),
                ...(body.service === "tv" && verifiedTVCustomerName
                  ? { customer_name: verifiedTVCustomerName }
                  : {}),
                ...(body.service === "tv" && verifiedTVCurrentBouquet
                  ? { current_bouquet: verifiedTVCurrentBouquet }
                  : {}),
              },
            })
            .eq("id", txId);
        }

        return json({
          success: true,
          transaction_id: txId,
          order_id: normalized.id ?? undefined,
          token: electricityToken,
          pins,
          serials,
          amount: plan.amount,
        });
      }

      if (outcome === "unknown") {
        // An unusual response can still contain VTUnaija's own transaction
        // identifier. Preserve it before returning Processing so both the
        // foreground verifier and scheduled reconciler can query the exact
        // provider record instead of relying on our client idempotency key.
        const providerTransactionId = normalized.id ?? normalized.ident;
        if (providerTransactionId) {
          await supabase
            .from("transactions")
            .update({
              metadata: {
                service: body.service,
                request: plan.providerPayload,
                provider: plan.provider,
                idempotency_key: requestId,
                provider_reference: requestId.replace(/[^a-zA-Z0-9]/g, ""),
                provider_transaction_id: providerTransactionId,
              },
            })
            .eq("id", txId)
            .eq("status", "pending");
        }
        // No documented pending state for VTUnaija airtime, but an
        // unrecognized/malformed response is NOT proof of failure 鈥?hold
        // pending (its default state), never refund, never resubmit the
        // purchase call. vtunaija-reconcile settles it via queryTransaction.
        return json({
          success: true,
          pending: true,
          transaction_id: txId,
          message: "Your order is still processing. You'll be notified once it completes.",
        });
      }

      // outcome === "failed": VTUnaija itself reports failure 鈥?no order was
      // created, safe to refund.
      await confirmServiceRefund(supabase, txId, normalized.message || "provider_rejected", "automatic");
      const lowerFailure = normalized.message.toLowerCase();
      const deterministicPlanFailure = lowerFailure.includes("does not exist") || lowerFailure.includes("refresh your plan");
      if (
        body.service === "data" && plan.availability &&
        deterministicPlanFailure
      ) {
        const { data: disabled } = await supabase.rpc("auto_disable_vtu_plan", {
          p_provider: "vtunaija",
          p_network: plan.availability.network,
          p_plan_id: plan.availability.planId,
          p_reason: "Provider reported that this data plan does not exist",
        });
        if (disabled === true) {
          await supabase.rpc("record_monitoring_alert", {
            p_fingerprint: `vtunaija_plan_${plan.availability.planId.replace(/[^a-z0-9_-]/gi, "_").toLowerCase()}`,
            p_type: "vtu_plan_auto_disabled",
            p_severity: "warning",
            p_details: {
              provider: "vtunaija",
              network: plan.availability.network,
              family_key: plan.availability.familyKey,
              plan_id: plan.availability.planId,
            },
          });
        }
      } else if (body.service === "data" && plan.availability) {
        await supabase.rpc("record_monitoring_alert", {
          p_fingerprint: `vtunaija_failure_${plan.availability.network}_${plan.availability.familyKey.replace(/[^a-z0-9_-]/gi, "_").toLowerCase()}`.slice(0, 100),
          p_type: "vtu_plan_provider_failure",
          p_severity: "warning",
          p_details: {
            provider: "vtunaija",
            network: plan.availability.network,
            family_key: plan.availability.familyKey,
          },
        });
      }
      return json({
        success: false,
        error: friendlyVtunaijaFailureMessage(normalized.message || ""),
      });
    } catch (e) {
      if (e instanceof VTUNaijaError) {
        // Config error 鈥?request never reached VTUnaija, refund is safe.
        await confirmServiceRefund(supabase, txId, `vtunaija_config: ${e.message}`, "automatic");
        return json({
          success: false,
          error: "The provider is temporarily unavailable. You were not charged.",
        });
      }
      // Network/timeout/parse error 鈥?genuinely ambiguous (the request may
      // have reached VTUnaija and been actioned, with only the response
      // lost). Hold pending; vtunaija-reconcile is the backstop.
      return json({
        success: true,
        pending: true,
        transaction_id: txId,
        message: "Your order is still processing. You'll be notified once it completes.",
      });
    }
  }

  return json({ success: false, error: "Unsupported provider routing" }, 500);
});
