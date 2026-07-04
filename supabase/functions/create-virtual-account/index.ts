import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { getAuthUser, adminClient } from "../_shared/auth.ts";

const PAYSTACK_SECRET = Deno.env.get("PAYSTACK_SECRET_KEY");
// "test-bank" in test mode; set to "wema-bank" / "titan-paystack" for live.
const DVA_BANK = Deno.env.get("PAYSTACK_DVA_BANK") || "test-bank";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function paystack(path: string, method: string, body?: unknown) {
  const res = await fetch(`https://api.paystack.co${path}`, {
    method,
    headers: { Authorization: `Bearer ${PAYSTACK_SECRET}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (!PAYSTACK_SECRET) return json({ error: "Paystack not configured" }, 500);

  const user = await getAuthUser(req);
  if (!user) return json({ error: "Unauthorized" }, 401);

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

  // 2. Create (or fetch) the Paystack customer for this user.
  const meta = (user.user_metadata || {}) as Record<string, string>;
  const fullName: string = meta.full_name || meta.name || (user.email?.split("@")[0] ?? "Customer");
  const [firstName, ...rest] = fullName.trim().split(/\s+/);
  const lastName = rest.join(" ") || firstName;

  const customerRes = await paystack("/customer", "POST", {
    email: user.email,
    first_name: firstName,
    last_name: lastName,
    phone: user.phone || meta.phone || undefined,
  });
  if (!customerRes.status) {
    return json({ success: false, error: customerRes.message || "Could not create customer" }, 400);
  }
  const customerCode = customerRes.data.customer_code;
  const customerId = String(customerRes.data.id ?? "");

  // 3. Create the dedicated NUBAN.
  const dvaRes = await paystack("/dedicated_account", "POST", {
    customer: customerCode,
    preferred_bank: DVA_BANK,
  });
  if (!dvaRes.status) {
    // Most common live cause: DVA not enabled on the account.
    return json(
      { success: false, error: dvaRes.message || "Could not create virtual account" },
      400,
    );
  }

  const acct = dvaRes.data;
  const account = {
    account_number: acct.account_number as string,
    bank_name: acct.bank?.name as string,
    account_name: acct.account_name as string,
  };

  // 4. Persist the mapping (service role).
  await supabase.from("virtual_accounts").upsert({
    user_id: user.id,
    customer_code: customerCode,
    customer_id: customerId,
    account_number: account.account_number,
    bank_name: account.bank_name,
    account_name: account.account_name,
    dva_id: String(acct.id ?? ""),
  });

  return json({ success: true, account });
});
