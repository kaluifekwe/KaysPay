import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { getAuthUser, adminClient } from "../_shared/auth.ts";
import { verifyNin as verifyNinPrembly, isPremblyConfigured } from "../_shared/prembly-client.ts";
import { verifyNin as verifyNinBvn, isNinBvnConfigured } from "../_shared/ninbvn-client.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Same record-shape normalizing as nin-verify — both providers wrap the
// record at different, live-confirmed depths (2026-07-05).
function extractRecord(data: any): any {
  const candidates = [data?.data?.data, data?.data, data];
  for (const c of candidates) {
    if (c && typeof c === "object" && typeof c.firstname === "string" && c.firstname.trim().length > 0) {
      return c;
    }
  }
  return undefined;
}

interface ProviderOutcome {
  ok: boolean;
  record?: any;
  errorMessage?: string;
}

async function tryPrembly(nin: string): Promise<ProviderOutcome> {
  const { status, data } = await verifyNinPrembly(nin);
  const record = extractRecord(data);
  const isTestData = typeof data?.message === "string" && /test data/i.test(data.message);
  const ok = status < 400 && !!record && !isTestData;
  return { ok, record, errorMessage: data?.message };
}

async function tryNinBvn(nin: string): Promise<ProviderOutcome> {
  const { status, data } = await verifyNinBvn(nin);
  const record = extractRecord(data);
  const ok = status < 400 && !!record;
  return { ok, record, errorMessage: ok ? undefined : (data?.message || data?.data?.message || `http_${status}`) };
}

// Free, self-serve KYC — deliberately NOT money-related: no wallet debit, no
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

  const nin = String(body?.nin || "").trim();
  if (!/^\d{11}$/.test(nin)) return json({ success: false, error: "Enter a valid 11-digit NIN" }, 400);

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

  if (isPremblyConfigured()) {
    try {
      outcome = await tryPrembly(nin);
      if (!outcome.ok) lastError = outcome.errorMessage;
    } catch (e) {
      lastError = (e as Error).message;
    }
  }

  if (!outcome.ok && isNinBvnConfigured()) {
    try {
      const fallback = await tryNinBvn(nin);
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
    return json({ success: false, error: lastError || "Could not verify this NIN. Please try again." });
  }

  const verifiedName = [outcome.record?.firstname, outcome.record?.middlename, outcome.record?.surname]
    .filter(Boolean)
    .join(" ");

  await supabase.from("user_kyc").upsert({
    user_id: user.id,
    status: "verified",
    nin,
    verified_record: outcome.record,
    verified_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  // Auto-sync the profile name to the verified NIN record — no confirmation
  // step, per the owner's spec.
  if (verifiedName) {
    await supabase.auth.admin.updateUserById(user.id, {
      user_metadata: { ...user.user_metadata, full_name: verifiedName },
    });
  }

  return json({ success: true, verified_name: verifiedName || undefined });
});
