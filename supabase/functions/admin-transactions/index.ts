import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { adminClient } from "../_shared/auth.ts";
import { AdminAuthError, requireAdmin } from "../_shared/admin-auth.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const PAGE_SIZE = 50;
const VALID_STATUSES = ["pending", "completed", "failed", "refunded"];
// Mirrors the live transactions_type_check constraint (see migration 082).
const VALID_TYPES = [
  "airtime", "data", "bill", "exam_pin", "foreign_number", "card_fund",
  "payroll", "wallet_fund", "refund", "withdrawal", "esim",
  "nin_verification", "nin_validation", "bvn_verification",
  "nin_name_modification", "nin_phone_modification", "nin_address_modification",
  "crypto_buy", "crypto_sell", "crypto_withdraw",
];

// Read-only paginated/filterable transactions list for the admin panel.
// Never exposes anything beyond what's already surfaced elsewhere in the
// app to the transaction's own owner (no new sensitive field added here).
serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    await requireAdmin(req, "support");
  } catch (e) {
    if (e instanceof AdminAuthError) return json({ error: e.message }, e.status);
    return json({ error: "Unauthorized" }, 401);
  }

  const url = new URL(req.url);
  const page = Math.max(0, Number(url.searchParams.get("page") || 0) || 0);
  const status = url.searchParams.get("status");
  // "types" (plural) supports the admin app's service groupings (e.g. all
  // NIN/BVN sub-types under one "Identity Verification" filter option) —
  // comma-separated, each checked against the same allowlist as before.
  const types = (url.searchParams.get("types") || "")
    .split(",")
    .map((t) => t.trim())
    .filter((t) => VALID_TYPES.includes(t));
  const phone = url.searchParams.get("phone");
  const dateFrom = url.searchParams.get("date_from");
  const dateTo = url.searchParams.get("date_to");

  const db = adminClient();
  let query = db
    .from("transactions")
    .select(
      "id, user_id, type, recipient_phone, network, amount_ngn, status, vtu_order_id, created_at, completed_at, metadata, users:user_id(full_name, phone), service_refunds(reason, origin, created_at)",
      { count: "exact" },
    )
    .order("created_at", { ascending: false })
    .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);

  if (status && VALID_STATUSES.includes(status)) query = query.eq("status", status);
  if (types.length > 0) query = query.in("type", types);
  if (phone) query = query.eq("recipient_phone", phone.trim().slice(0, 20));
  if (dateFrom) query = query.gte("created_at", dateFrom);
  if (dateTo) query = query.lte("created_at", dateTo);

  const { data, error, count } = await query;
  if (error) return json({ error: "Could not load transactions" }, 500);

  // public.users.full_name is never actually populated (see migration 088)
  // — the real name lives in auth.users' own metadata, which PostgREST
  // can't embed directly. Batch-resolve it in one extra call rather than
  // one per row.
  const rows = data ?? [];
  for (const row of rows as unknown as {
    type?: string;
    metadata?: Record<string, unknown>;
    refund_verification?: unknown;
    funding_provider?: string | null;
    funding_reference?: string | null;
  }[]) {
    row.refund_verification = row.metadata?.refund_verification ?? null;
    if (row.type === "wallet_fund") {
      const provider = row.metadata?.source;
      const reference = row.metadata?.reference ?? row.metadata?.idempotency_reference;
      row.funding_provider = typeof provider === "string" ? provider : null;
      row.funding_reference = typeof reference === "string" ? reference : null;
    }
    delete row.metadata;
  }
  const userIds = [...new Set(rows.map((r) => r.user_id))];
  if (userIds.length > 0) {
    const { data: details } = await db.rpc("admin_resolve_user_details", { p_user_ids: userIds });
    const detailByUserId = new Map<string, { fullName: string | null; phone: string | null }>(
      (details || []).map((detail: { user_id: string; full_name: string | null; phone: string | null }) => [
        detail.user_id,
        { fullName: detail.full_name, phone: detail.phone },
      ] as const),
    );
    for (const row of rows as unknown as { user_id: string; users: { full_name: string | null; phone: string | null } | null }[]) {
      const resolved = detailByUserId.get(row.user_id);
      if (row.users && resolved) {
        row.users.full_name = resolved.fullName;
        row.users.phone = resolved.phone;
      }
    }
  }

  return json({ success: true, transactions: rows, total: count ?? 0, page, page_size: PAGE_SIZE });
});
