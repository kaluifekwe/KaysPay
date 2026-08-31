import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { adminClient, enforceRateLimit, getAuthUser, readJsonBody } from "../_shared/auth.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
  });
}

serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  const user = await getAuthUser(req);
  if (!user) return json({ success: false, error: "Unauthorized" }, 401);

  const db = adminClient();
  const rate = await enforceRateLimit(db, "billing_accounts", user.id, 60, 300, user.id);
  if (!rate.allowed) {
    return json({ success: false, error: "Too many requests. Please try again shortly." }, 429);
  }

  let body: Record<string, unknown> = {};
  try {
    body = await readJsonBody(req);
  } catch {
    return json({ success: false, error: "Invalid request body" }, 400);
  }

  const action = String(body.action || "list");
  if (action === "list") {
    const service = String(body.service || "");
    const providerId = String(body.provider_id || "").toLowerCase();
    if (!['tv', 'electricity'].includes(service) || !/^[a-z0-9-]{2,50}$/.test(providerId)) {
      return json({ success: false, error: "Invalid account filter" }, 400);
    }

    const page = Math.max(0, Math.min(100, Number(body.page) || 0));
    const pageSize = 50;
    const { data, error } = await db
      .from("saved_billing_accounts")
      // due_date/renewal_amount_kobo let a saved card show its full details
      // the moment it is tapped, instead of holding the customer on a ~1.2s
      // provider round trip at the point they are ready to pay.
      .select("id, service, provider_id, account_number, customer_name, customer_address, due_date, renewal_amount_kobo, last_verified_at, last_used_at")
      .eq("user_id", user.id)
      .eq("service", service)
      .eq("provider_id", providerId)
      .order("last_used_at", { ascending: false })
      .range(page * pageSize, page * pageSize + pageSize);
    if (error) return json({ success: false, error: "Could not load saved accounts" }, 500);
    const rows = data ?? [];
    return json({
      success: true,
      accounts: rows.slice(0, pageSize),
      has_more: rows.length > pageSize,
      page,
    });
  }

  if (action === "delete") {
    const id = String(body.id || "");
    if (!/^[0-9a-f-]{36}$/i.test(id)) return json({ success: false, error: "Invalid account" }, 400);
    const { error } = await db.from("saved_billing_accounts").delete().eq("id", id).eq("user_id", user.id);
    if (error) return json({ success: false, error: "Could not remove saved account" }, 500);
    return json({ success: true });
  }

  return json({ success: false, error: "Unknown action" }, 400);
});
