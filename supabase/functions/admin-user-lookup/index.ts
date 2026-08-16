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

// Read-only. Two modes: ?q=<search> returns a short list of matches by
// phone/name; ?user_id=<uuid> returns one user's full profile detail.
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
  const q = url.searchParams.get("q")?.trim();
  const userId = url.searchParams.get("user_id")?.trim();
  const db = adminClient();

  if (userId) {
    const { data: profile, error: profileError } = await db
      .from("users")
      .select("id, full_name, phone, created_at, last_active")
      .eq("id", userId)
      .maybeSingle();
    if (profileError || !profile) return json({ error: "User not found" }, 404);

    const [wallet, kyc, txCount, authUser] = await Promise.all([
      db.from("wallets").select("balance, locked_amount").eq("user_id", userId).maybeSingle(),
      db.from("user_kyc").select("status").eq("user_id", userId).maybeSingle(),
      db.from("transactions").select("id", { count: "exact", head: true }).eq("user_id", userId),
      db.auth.admin.getUserById(userId),
    ]);

    // public.users.full_name is never actually populated (see migration
    // 088) — the real name lives in auth.users' own metadata.
    const resolvedName = (authUser.data?.user?.user_metadata as { full_name?: string } | undefined)?.full_name || null;

    return json({
      success: true,
      user: {
        ...profile,
        full_name: resolvedName,
        email: authUser.data?.user?.email ?? null,
        wallet_balance_kobo: wallet.data?.balance ?? null,
        wallet_locked_kobo: wallet.data?.locked_amount ?? null,
        kyc_status: kyc.data?.status ?? "unverified",
        transaction_count: txCount.count ?? 0,
      },
    });
  }

  if (!q || q.length < 3) {
    return json({ error: "Search term must be at least 3 characters" }, 400);
  }
  const safeQ = q.slice(0, 60);

  // Same reason as above — searching public.users.full_name would never
  // match anything real, so this goes through a SECURITY DEFINER function
  // that can also see auth.users' metadata. p_query is a bound RPC
  // parameter, not string-interpolated SQL, so this is injection-safe.
  const { data, error } = await db.rpc("admin_search_users", { p_query: safeQ });

  if (error) return json({ error: "Search failed" }, 500);
  return json({ success: true, matches: data });
});
