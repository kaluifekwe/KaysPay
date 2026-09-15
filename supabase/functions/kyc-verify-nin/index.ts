import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { getAuthUser, adminClient } from "../_shared/auth.ts";
import {
  verifyNinBasic as verifyNinPrembly,
  verifyBvn as verifyBvnPrembly,
  isPremblyConfigured,
} from "../_shared/prembly-client.ts";
import {
  verifyNin as verifyNinBvn,
  verifyBvn as verifyBvnNinBvn,
  isNinBvnConfigured,
} from "../_shared/ninbvn-client.ts";
import { isServiceEnabled } from "../_shared/auth.ts";
import { is9PsbConfigured } from "../_shared/9psb-client.ts";
import { startNinePsbProvisioning } from "../_shared/9psb-provisioning.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
  });
}

// Free-tier record-shape normalizing. NIN responses use lowercase
// firstname/middlename/surname; BVN responses vary by provider �?Prembly's
// BVN endpoint returns camelCase (firstName/middleName/lastName),
// CheckMyNINBVN's uses lowercase but "lastname" instead of "surname" (see
// bvn-verify's own extractBvnRecord, which normalizes the same spellings
// for the paid slip flow). One extractor covers every shape either
// identifier type can come back in.
function pick(c: any, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = c[k];
    if (v !== undefined && v !== null && v !== "") return typeof v === "string" ? v : String(v);
  }
  return undefined;
}

function extractRecord(data: any): any {
  const candidates = [data?.data?.data, data?.data, data];
  for (const c of candidates) {
    if (!c || typeof c !== "object") continue;
    const firstname = pick(c, "firstname", "firstName", "first_name");
    if (typeof firstname === "string" && firstname.trim().length > 0) {
      return {
        ...c,
        firstname,
        middlename: pick(c, "middlename", "middleName", "middle_name"),
        surname: pick(c, "surname", "lastname", "lastName", "last_name"),
      };
    }
  }
  return undefined;
}

interface ProviderOutcome {
  ok: boolean;
  record?: any;
  errorMessage?: string;
}

async function tryPremblyNin(nin: string): Promise<ProviderOutcome> {
  const { status, data } = await verifyNinPrembly(nin);
  const record = extractRecord(data);
  const isTestData = typeof data?.message === "string" && /test data/i.test(data.message);
  const ok = status < 400 && !!record && !isTestData;
  return { ok, record, errorMessage: data?.message };
}

async function tryNinBvnNin(nin: string): Promise<ProviderOutcome> {
  const { status, data } = await verifyNinBvn(nin);
  const record = extractRecord(data);
  const ok = status < 400 && !!record;
  return { ok, record, errorMessage: ok ? undefined : (data?.message || data?.data?.message || `http_${status}`) };
}

// BVN variants �?same free, no-wallet-debit model as the NIN checks above.
// Deliberately uses Prembly's lighter bvn_validation endpoint, NOT
// verifyBvnFull (the richer, costlier lookup reserved for the paid slip
// product in bvn-verify) �?this only ever needs a name to confirm identity.
async function tryPremblyBvn(bvn: string): Promise<ProviderOutcome> {
  const { status, data } = await verifyBvnPrembly(bvn);
  const record = extractRecord(data);
  const ok = status < 400 && !!record;
  return { ok, record, errorMessage: data?.message || data?.detail };
}

async function tryNinBvnBvn(bvn: string): Promise<ProviderOutcome> {
  const { status, data } = await verifyBvnNinBvn(bvn);
  const record = extractRecord(data);
  const ok = status < 400 && !!record;
  return { ok, record, errorMessage: ok ? undefined : (data?.message || `http_${status}`) };
}

// Free, self-serve KYC �?deliberately NOT money-related: no wallet debit, no
// PIN step-up (being logged in is enough, same trust level as changing a
// PIN). Since it's free to the user but still costs the owner per provider
// call, it's capped per-user to stop it being used to hammer a paid API.
serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (!isPremblyConfigured() && !isNinBvnConfigured()) {
    return json({ success: false, error: "KYC verification not configured" }, 500);
  }

  const user = await getAuthUser(req);
  if (!user) return json({ success: false, error: "Unauthorized" }, 401);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ success: false, error: "Invalid request body" }, 400);
  }

  // Accepts either identifier �?whichever the user has on hand. Exactly one
  // must be present; a client sending both is treated as NIN (shouldn't
  // happen, KycScreen only ever sends one).
  const nin = String(body?.nin || "").trim();
  const bvn = String(body?.bvn || "").trim();
  const idType: "nin" | "bvn" | null = nin ? "nin" : bvn ? "bvn" : null;
  if (idType === "nin" && !/^\d{11}$/.test(nin)) {
    return json({ success: false, error: "Enter a valid 11-digit NIN" }, 400);
  }
  if (idType === "bvn" && !/^\d{11}$/.test(bvn)) {
    return json({ success: false, error: "Enter a valid 11-digit BVN" }, 400);
  }
  if (!idType) return json({ success: false, error: "Enter a valid 11-digit NIN or BVN" }, 400);

  const supabase = adminClient();

  const { data: existing } = await supabase
    .from("user_kyc")
    .select("status")
    .eq("user_id", user.id)
    .maybeSingle();

  if (existing?.status === "verified") {
    return json({ success: false, error: "You're already verified." });
  }

  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count } = await supabase
    .from("kyc_attempts")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id)
    .gte("created_at", cutoff);

  if ((count || 0) >= 5) {
    return json({ success: false, error: "Too many attempts today. Please try again tomorrow." });
  }

  await supabase.from("kyc_attempts").insert({ user_id: user.id });

  let outcome: ProviderOutcome = { ok: false };
  let lastError: string | undefined;
  const [tryPrimary, tryFallback] = idType === "nin"
    ? [tryPremblyNin, tryNinBvnNin]
    : [tryPremblyBvn, tryNinBvnBvn];
  const idValue = idType === "nin" ? nin : bvn;

  if (isPremblyConfigured()) {
    try {
      outcome = await tryPrimary(idValue);
      if (!outcome.ok) lastError = outcome.errorMessage;
    } catch (e) {
      lastError = (e as Error).message;
    }
  }

  if (!outcome.ok && isNinBvnConfigured()) {
    try {
      const fallback = await tryFallback(idValue);
      if (fallback.ok) {
        outcome = fallback;
      } else {
        lastError = fallback.errorMessage || lastError;
      }
    } catch (e) {
      lastError = (e as Error).message;
    }
  }

  if (!outcome.ok) {
    const label = idType === "nin" ? "NIN" : "BVN";
    return json({ success: false, error: lastError || `Could not verify this ${label}. Please try again.` });
  }

  const verifiedName = [outcome.record?.firstname, outcome.record?.middlename, outcome.record?.surname]
    .filter(Boolean)
    .join(" ");

  // One verified identity per account. record_kyc_verified is the single
  // choke point: it checks (and, via a unique index, ultimately enforces)
  // that no OTHER account already holds this same NIN/BVN as verified,
  // before ever writing this one. Confirmed live 2026-09-05 that nothing
  // previously checked this at all -- a live scan of every existing
  // verified row found no duplicates yet, but nothing stopped one.
  const { data: kycResult, error: kycError } = await supabase.rpc("record_kyc_verified", {
    p_user_id: user.id,
    p_nin: idType === "nin" ? nin : null,
    p_bvn: idType === "bvn" ? bvn : null,
    p_verified_record: outcome.record,
  });
  if (kycError) {
    console.error("kyc-verify-nin: record_kyc_verified failed:", kycError.message);
    return json({ success: false, error: "Could not complete verification. Please try again." }, 500);
  }
  const row = kycResult?.[0];
  if (!row?.ok) {
    // Flagged for review rather than silently rejected into the void --
    // this could be a genuine duplicate-account attempt, or a real edge
    // case (a locked-out account needing a fresh one) that only a human
    // can tell apart. Fingerprinted on both accounts so a retry doesn't
    // spam a fresh alert every attempt.
    await supabase.rpc("record_monitoring_alert", {
      p_fingerprint: `kyc_duplicate_identity_${[user.id, row?.duplicate_user_id].sort().join("_")}`.slice(0, 100),
      p_type: "kyc_duplicate_identity",
      p_severity: "warning",
      p_details: {
        id_type: idType,
        requesting_user_id: user.id,
        already_verified_user_id: row?.duplicate_user_id ?? null,
      },
    });
    const label = idType === "nin" ? "NIN" : "BVN";
    return json({
      success: false,
      error: `This ${label} is already linked to another KaysPay account. Contact support if you believe this is a mistake.`,
    });
  }

  // Auto-sync the profile name to the verified record �?no confirmation
  // step, per the owner's spec.
  if (verifiedName) {
    await supabase.auth.admin.updateUserById(user.id, {
      user_metadata: { ...user.user_metadata, full_name: verifiedName },
    });
  }

  // Any real bank transfers received before verification were recorded as
  // non-spendable compliance holds. Release them through the same atomic,
  // idempotent wallet-credit path immediately after KYC succeeds.
  const { error: releaseError } = await supabase.rpc("release_verified_funding_holds", {
    p_user_id: user.id,
  });
  if (releaseError) {
    // Verification itself remains valid; reconciliation/support can safely
    // retry the idempotent release without risking a double credit.
    console.error("Could not release verified funding holds:", releaseError.code || "UNKNOWN");
  }

  // Best-effort, non-blocking: kick off 9PSB WAAS wallet provisioning's
  // Call 1 automatically the moment KYC completes, so the customer doesn't
  // need to separately visit "Fund Wallet" later to discover a 9PSB option
  // exists. Verification itself must never fail because of this — gated
  // behind the closed-testing-only kill switch, and any failure here is
  // just logged; startNinePsbProvisioning is safely re-callable later
  // (by 9psb-create-wallet itself, or a future retry) since it self-heals
  // from whatever partial state it finds.
  if (await isServiceEnabled(supabase, "9psb_waas").catch(() => false)) {
    if (is9PsbConfigured()) {
      try {
        await startNinePsbProvisioning(supabase, {
          userId: user.id,
          verifiedIdentifier: String(idType === "nin" ? nin : bvn),
          usingNin: idType === "nin",
          phone: user.phone || undefined,
        });
      } catch (e) {
        console.error("9PSB auto-provisioning on KYC completion failed:", e instanceof Error ? e.message : "UNKNOWN");
      }
    }
  }

  return json({ success: true, verified_name: verifiedName || undefined });
});
