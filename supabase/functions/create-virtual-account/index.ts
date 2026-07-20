import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { getAuthUser, adminClient } from "../_shared/auth.ts";
import { createCustomer, createStaticVirtualAccount, isFlutterwaveConfigured } from "../_shared/flutterwave-client.ts";

// Flutterwave's top-level error.message is a generic "Request is not valid"
// — the actually useful reason is in error.validation_errors. Surface both
// so callers (and our own logs) see what actually failed.
function flwErrorMessage(data: any, fallback: string): string {
  const details = data?.error?.validation_errors
    ?.map((v: any) => `${v.field_name}: ${v.message}`)
    .join("; ");
  return details || data?.error?.message || data?.message || fallback;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (!isFlutterwaveConfigured()) return json({ error: "Bank transfer funding not configured" }, 500);

  const user = await getAuthUser(req);
  if (!user) return json({ error: "Unauthorized" }, 401);

  try {
    return await handleRequest(req, user);
  } catch (e) {
    console.error("create-virtual-account unhandled error:", (e as Error).message);
    return json({ success: false, error: (e as Error).message || "Unexpected error" }, 500);
  }
});

async function handleRequest(req: Request, user: NonNullable<Awaited<ReturnType<typeof getAuthUser>>>) {
  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    // no body is fine — bvn_or_nin is only required on first creation
  }
  const bvnOrNin = typeof body.bvn_or_nin === "string" ? body.bvn_or_nin.trim() : "";

  const supabase = adminClient();

  // 1. Already provisioned? Return it (idempotent).
  const { data: existing } = await supabase
    .from("virtual_accounts")
    .select("account_number, bank_name, account_name")
    .eq("user_id", user.id)
    .maybeSingle();

  if (existing?.account_number) {
    return json({ success: true, account: existing });
  }

  if (!/^\d{11}$/.test(bvnOrNin)) {
    return json({ success: false, error: "A valid 11-digit BVN or NIN is required" }, 400);
  }

  // Flutterwave's `reference` field must be alphanumeric only — derive a
  // stable, unique one from the user id (also doubles as the idempotency key).
  const refBase = `kp${user.id.replace(/-/g, "")}`;

  // 2. Create (or fetch) the Flutterwave customer for this user.
  // Flutterwave requires name.first/name.last to each be 2-50 chars of only
  // letters/spaces/commas/periods/apostrophes/hyphens — sanitize and fall
  // back defensively, since user_metadata.full_name can be missing,
  // whitespace-only, or contain characters it rejects (e.g. digits).
  const meta = (user.user_metadata || {}) as Record<string, string>;
  const rawName = [meta.full_name, meta.name]
    .map((v) => (v || "").trim())
    .find((v) => v.length > 0) || (user.email?.split("@")[0] ?? "Customer");
  const [rawFirst, ...rawRest] = rawName.split(/\s+/);
  const sanitizeNamePart = (part: string): string => {
    const cleaned = part.replace(/[^a-zA-Z\s,.'-]/g, "").trim().slice(0, 50);
    return cleaned.length >= 2 ? cleaned : "Customer";
  };
  const firstName = sanitizeNamePart(rawFirst);
  const lastName = sanitizeNamePart(rawRest.join(" ") || rawFirst);

  if (!user.email) {
    return json({ success: false, error: "An email on file is required for bank transfer funding" }, 400);
  }

  const custRes = await createCustomer(supabase, { firstName, lastName, email: user.email }, refBase);
  if (custRes.status >= 400 || custRes.data?.status !== "success") {
    // Log only a safe summary — never the raw response body, which can echo
    // back submitted PII (see the bvnOrNin case below) on validation failures.
    console.error("Flutterwave create-customer failed:", JSON.stringify({ status: custRes.status, message: custRes.data?.message }));
    return json(
      { success: false, error: flwErrorMessage(custRes.data, "Could not create customer") },
      400,
    );
  }
  const customerId = custRes.data.data.id as string;

  // 3. Create the static virtual account.
  const vaRes = await createStaticVirtualAccount(supabase, {
    customerId,
    reference: refBase,
    // Combines brand + real KYC'd name — the bank's own name-enquiry may
    // still only surface the verified customer name regardless of this
    // (untested), but this is the best-effort branding option that doesn't
    // risk breaking the fraud-prevention purpose of name-enquiry. Avoiding
    // "/" since narration likely has the same restricted character set as
    // name.first/name.last (letters/spaces/commas/periods/apostrophes/hyphens).
    narration: `KaysPay - ${firstName} ${lastName}`,
    bvnOrNin,
  }, `${refBase}va`);
  if (vaRes.status >= 400 || vaRes.data?.status !== "success") {
    // Log only which fields failed, never the validation message text — this
    // request includes bvnOrNin, and KYC validation errors can echo the
    // submitted value back in the message.
    const failedFields = vaRes.data?.error?.validation_errors?.map((v: any) => v.field_name);
    console.error("Flutterwave create-virtual-account failed:", JSON.stringify({ status: vaRes.status, message: vaRes.data?.message, failedFields }));
    return json(
      { success: false, error: flwErrorMessage(vaRes.data, "Could not create virtual account") },
      400,
    );
  }

  const acct = vaRes.data.data;
  const account = {
    account_number: acct.account_number as string,
    bank_name: acct.account_bank_name as string,
    account_name: acct.narration as string,
  };

  // 4. Persist the mapping (service role). customer_code/dva_id are reused
  // generically for Flutterwave's customer id ("cus_...") and account id
  // ("van_...") — see migration 023.
  await supabase.from("virtual_accounts").upsert({
    user_id: user.id,
    customer_code: customerId,
    account_number: account.account_number,
    bank_name: account.bank_name,
    account_name: account.account_name,
    dva_id: String(acct.id ?? ""),
  });

  return json({ success: true, account });
}
