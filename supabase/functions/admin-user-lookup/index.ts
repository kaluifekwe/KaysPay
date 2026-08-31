import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { adminClient } from "../_shared/auth.ts";
import { AdminAuthError, requireAdmin } from "../_shared/admin-auth.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
  });
}

// Read-only. Two modes: ?q=<search> returns a short list of matches by
// phone/name; ?user_id=<uuid> returns one user's full profile detail.
serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  let admin;
  try {
    admin = await requireAdmin(req, "support");
  } catch (e) {
    if (e instanceof AdminAuthError) return json({ error: e.message }, e.status);
    return json({ error: "Unauthorized" }, 401);
  }

  const url = new URL(req.url);
  const q = url.searchParams.get("q")?.trim();
  const userId = url.searchParams.get("user_id")?.trim();
  const requestedSource = url.searchParams.get("source")?.trim();
  const source = requestedSource === "transaction_detail" ? "transaction_detail" : "user_lookup";
  const db = adminClient();

  if (userId) {
    const { data: profile, error: profileError } = await db
      .from("users")
      .select("id, full_name, phone, created_at, last_active")
      .eq("id", userId)
      .maybeSingle();
    if (profileError) return json({ error: "Could not load user" }, 500);

    // A deleted Auth/profile row is intentionally absent, but the stable
    // audit subject remains addressable by UUID for regulated record review.
    if (!profile) {
      const [{ data: subject }, txCount] = await Promise.all([
        db.from("customer_subjects").select("subject_id,joined_at,deleted_at").eq("subject_id", userId).maybeSingle(),
        db.from("transactions").select("id", { count: "exact", head: true }).eq("user_id", userId),
      ]);
      if (!subject) return json({ error: "User not found" }, 404);
      return json({ success: true, user: {
        id: subject.subject_id, full_name: null, phone: null, email: null,
        created_at: subject.joined_at, last_active: null, deleted_at: subject.deleted_at,
        wallet_balance_kobo: null, wallet_locked_kobo: null, kyc_status: "deleted",
        transaction_count: txCount.count ?? 0,
        funding_hold_count: 0, funding_hold_kobo: 0,
      } });
    }

    const [wallet, kyc, txCount, authUser, fundingHolds] = await Promise.all([
      db.from("wallets").select("balance, locked_amount").eq("user_id", userId).maybeSingle(),
      db.from("user_kyc").select("status").eq("user_id", userId).maybeSingle(),
      db.from("transactions").select("id", { count: "exact", head: true }).eq("user_id", userId),
      db.auth.admin.getUserById(userId),
      db.from("funding_compliance_holds")
        .select("amount_kobo")
        .eq("user_id", userId)
        .in("status", ["held", "refund_pending", "manual_review"]),
    ]);
    if (fundingHolds.error) return json({ error: "Could not load funding compliance status" }, 500);
    const heldFundingKobo = (fundingHolds.data ?? []).reduce(
      (total, hold) => total + Number(hold.amount_kobo || 0),
      0,
    );

    // public.users.full_name is never actually populated (see migration
    // 088) â€?the real name lives in auth.users' own metadata.
    const authMetadata = authUser.data?.user?.user_metadata as {
      full_name?: string;
      phone?: string;
      phone_number?: string;
    } | undefined;
    const resolvedName = authMetadata?.full_name || null;
    const resolvedPhone = profile.phone
      || authUser.data?.user?.phone
      || authMetadata?.phone
      || authMetadata?.phone_number
      || null;

    // Contact information is operationally necessary but still PII. Fail
    // closed if the access cannot be audited, and never write the phone
    // number itself into the audit record.
    const { error: auditError } = await db.from("admin_actions").insert({
      admin_user_id: admin.userId,
      action_type: "view_customer_contact",
      target_type: "users",
      target_id: userId,
      metadata: { source, phone_available: Boolean(resolvedPhone) },
    });
    if (auditError) return json({ error: "Could not record contact access" }, 500);

    return json({
      success: true,
      user: {
        ...profile,
        full_name: resolvedName,
        phone: resolvedPhone,
        email: authUser.data?.user?.email ?? null,
        wallet_balance_kobo: wallet.data?.balance ?? null,
        wallet_locked_kobo: wallet.data?.locked_amount ?? null,
        kyc_status: kyc.data?.status ?? "unverified",
        transaction_count: txCount.count ?? 0,
        funding_hold_count: fundingHolds.data?.length ?? 0,
        funding_hold_kobo: heldFundingKobo,
      },
    });
  }

  if (!q || q.length < 3) {
    return json({ error: "Search term must be at least 3 characters" }, 400);
  }
  const safeQ = q.slice(0, 60);

  // Same reason as above â€?searching public.users.full_name would never
  // match anything real, so this goes through a SECURITY DEFINER function
  // that can also see auth.users' metadata. p_query is a bound RPC
  // parameter, not string-interpolated SQL, so this is injection-safe.
  const { data, error } = await db.rpc("admin_search_users", { p_query: safeQ });

  if (error) return json({ error: "Search failed" }, 500);
  const matches = data ?? [];
  const { error: auditError } = await db.from("admin_actions").insert({
    admin_user_id: admin.userId,
    action_type: "search_customer_contacts",
    target_type: "users",
    target_id: null,
    metadata: {
      result_count: matches.length,
      phone_results: matches.filter((match: { phone?: string | null }) => Boolean(match.phone)).length,
    },
  });
  if (auditError) return json({ error: "Could not record contact access" }, 500);
  if ((data?.length ?? 0) === 0 && UUID_PATTERN.test(safeQ)) {
    const { data: subject } = await db.from("customer_subjects")
      .select("subject_id,joined_at,deleted_at").eq("subject_id", safeQ).maybeSingle();
    if (subject) return json({ success: true, matches: [{
      id: subject.subject_id, full_name: null, phone: null,
      created_at: subject.joined_at, deleted_at: subject.deleted_at,
    }] });
  }
  return json({ success: true, matches: data });
});
