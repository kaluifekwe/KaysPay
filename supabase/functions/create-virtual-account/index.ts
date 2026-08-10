import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { getAuthUser, adminClient } from "../_shared/auth.ts";
import { createCustomer, createStaticVirtualAccount, isFlutterwaveConfigured } from "../_shared/flutterwave-client.ts";
import { createPaystackDedicatedAccount, getOrCreatePaystackCustomer, isPaystackConfigured } from "../_shared/paystack-client.ts";
import { redactSecrets } from "../_shared/redact.ts";

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

  const user = await getAuthUser(req);
  if (!user) return json({ error: "Unauthorized" }, 401);

  try {
    return await handleRequest(req, user);
  } catch (e) {
    console.error("create-virtual-account unhandled error:", redactSecrets(e));
    return json({ success: false, error: "We couldn't set up your account right now. Please try again." }, 500);
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
  const provider = body.provider === "paystack" ? "paystack" : body.provider === "flutterwave" ? "flutterwave" : null;
  if (!provider) return json({ success: false, error: "Please choose a valid provider" }, 400);

  // Config gate is per-provider — a Paystack outage or missing secret must
  // never block Flutterwave (the existing, working path), and vice versa.
  if (provider === "flutterwave" && !isFlutterwaveConfigured()) {
    return json({ error: "Bank transfer funding not configured" }, 500);
  }
  if (provider === "paystack" && !isPaystackConfigured()) {
    return json({ success: false, error: "Paystack funding isn't available right now. Please use Flutterwave for now." }, 503);
  }

  const supabase = adminClient();

  // 1. Already provisioned FOR THIS PROVIDER? Return it (idempotent). A user
  // may hold one account per provider — requesting Paystack after already
  // having a Flutterwave account provisions a fresh Paystack row, not the
  // existing flutterwave one.
  const { data: existing } = await supabase
    .from("virtual_accounts")
    .select("account_number, bank_name, account_name")
    .eq("user_id", user.id)
    .eq("provider", provider)
    .maybeSingle();

  if (existing?.account_number) {
    return json({ success: true, account: existing });
  }

  if (provider === "flutterwave" && !/^\d{11}$/.test(bvnOrNin)) {
    return json({ success: false, error: "A valid 11-digit BVN or NIN is required" }, 400);
  }

  // A stable, alphanumeric-only reference derived from the user id — safe
  // for both providers, and doubles as an idempotency key.
  const refBase = `kp${user.id.replace(/-/g, "")}`;

  // Derive a clean display name for both providers. Flutterwave requires
  // name.first/name.last to each be 2-50 chars of only letters/spaces/
  // commas/periods/apostrophes/hyphens — sanitize and fall back
  // defensively, since user_metadata.full_name can be missing,
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

  if (provider === "paystack") {
    return await createPaystackAccount(supabase, user, { firstName, lastName });
  }

  const custRes = await createCustomer(supabase, { firstName, lastName, email: user.email }, refBase);
  if (custRes.status >= 400 || custRes.data?.status !== "success") {
    // Log only a safe summary — never the raw response body, which can echo
    // back submitted PII (see the bvnOrNin case below) on validation failures.
    console.error("Flutterwave create-customer failed:", redactSecrets(JSON.stringify({ status: custRes.status, message: custRes.data?.message })));
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
    // Deliberately DO NOT log vaRes.data.message — this request carries BVN/NIN
    // and KYC validation messages can echo the submitted value back. Fields only.
    console.error("Flutterwave create-virtual-account failed:", JSON.stringify({ status: vaRes.status, failedFields }));
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
  const { error: mappingError } = await supabase.from("virtual_accounts").upsert({
    user_id: user.id,
    provider,
    customer_code: customerId,
    account_number: account.account_number,
    bank_name: account.bank_name,
    account_name: account.account_name,
    dva_id: String(acct.id ?? ""),
  }, { onConflict: "user_id,provider" });
  if (mappingError) {
    console.error("Flutterwave virtual-account mapping failed:", redactSecrets(mappingError));
    return json({
      success: false,
      error: "Your account was created but could not be linked safely. Please try again before transferring money.",
    }, 503);
  }

  return json({ success: true, account });
}

async function createPaystackAccount(
  supabase: ReturnType<typeof adminClient>,
  user: NonNullable<Awaited<ReturnType<typeof getAuthUser>>>,
  params: { firstName: string; lastName: string },
) {
  const meta = (user.user_metadata || {}) as Record<string, string>;
  const rawPhone = String(user.phone || meta.phone || meta.phone_number || "").trim();
  let phone = rawPhone.replace(/[^\d]/g, "");
  if (phone.startsWith("234") && phone.length === 13) {
    phone = "+" + phone;
  } else if (phone.startsWith("0") && phone.length === 11) {
    phone = "+234" + phone.slice(1);
  }
  const customerRes = await getOrCreatePaystackCustomer({
    email: user.email!,
    firstName: params.firstName,
    lastName: params.lastName,
    ...( /^\+234\d{10}$/.test(phone) ? { phone } : {} ),
  });
  if (customerRes.status >= 400 || customerRes.data?.status !== true) {
    console.error("Paystack customer request failed:", redactSecrets(JSON.stringify({ status: customerRes.status, message: customerRes.data?.message })));
    return json({ success: false, error: customerRes.data?.message || "Could not create Paystack customer" }, 400);
  }

  const customer = customerRes.data.data;
  const customerCode = String(customer.customer_code);
  const { error: customerPersistError } = await supabase.from("virtual_accounts").upsert({
    user_id: user.id,
    provider: "paystack",
    customer_code: customerCode,
    customer_id: String(customer.id ?? ""),
  }, { onConflict: "user_id,provider" });
  if (customerPersistError) throw customerPersistError;

  const existingDva = customer?.dedicated_account;
  const dvaRes = existingDva?.account_number
    ? { status: 200, data: { status: true, data: existingDva } }
    : await createPaystackDedicatedAccount(customerCode);
  if (dvaRes.status >= 400 || dvaRes.data?.status !== true) {
    console.error("Paystack DVA request failed:", redactSecrets(JSON.stringify({ status: dvaRes.status, message: dvaRes.data?.message })));
    return json({ success: false, error: dvaRes.data?.message || "Could not create Paystack account" }, 400);
  }

  const acct = dvaRes.data?.data;
  if (!acct?.account_number) {
    console.error("Paystack DVA response did not contain an account number");
    return json({ success: false, error: "Paystack is still assigning your account. Please try again shortly." }, 202);
  }
  const account = {
    account_number: String(acct.account_number),
    bank_name: String(acct.bank?.name || acct.bank_name || "Paystack"),
    account_name: String(acct.account_name || `${params.firstName} ${params.lastName}`),
  };

  const { error: persistError } = await supabase.from("virtual_accounts").upsert({
    user_id: user.id,
    provider: "paystack",
    customer_code: customerCode,
    customer_id: String(customer.id ?? ""),
    account_number: account.account_number,
    bank_name: account.bank_name,
    account_name: account.account_name,
    dva_id: String(acct.id ?? ""),
  }, { onConflict: "user_id,provider" });
  if (persistError) throw persistError;

  return json({ success: true, account });
}
