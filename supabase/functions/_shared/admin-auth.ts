import { adminClient, enforceRateLimit, getAuthUser } from "./auth.ts";

export type AdminRole = "support" | "super_admin";

export class AdminAuthError extends Error {
  constructor(public readonly status: 401 | 403 | 429, message: string) {
    super(message);
  }
}

const ROLE_RANK: Record<AdminRole, number> = { support: 1, super_admin: 2 };

/**
 * Per-admin, per-function ceiling. Deliberately generous: the admin panel
 * fires one request per page action with no polling (see adminApi.ts), so a
 * person cannot approach 120/min, while a script pulling records in bulk is
 * capped hard. This is the containment boundary for a COMPROMISED or rogue
 * support account — the role check above already stops everyone else.
 */
const ADMIN_MAX_PER_MINUTE = 120;

/**
 * Derive a rate-limit scope from the function being called, so each admin
 * endpoint gets its own bucket rather than sharing one global allowance.
 * enforce_abuse_rate_limit validates scope against ^[a-z0-9_-]{2,64}$, so
 * anything unexpected in the path is normalised away and falls back to a
 * safe constant instead of raising INVALID_RATE_LIMIT_CONFIG.
 */
function scopeForRequest(req: Request): string {
  let name = "";
  try {
    name = new URL(req.url).pathname.split("/").filter(Boolean).pop() ?? "";
  } catch {
    name = "";
  }
  const cleaned = name.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 55);
  return cleaned.length >= 2 ? `admin_${cleaned}` : "admin_unknown";
}

/**
 * Every admin-* Edge Function calls this first. Verifies the caller's JWT,
 * then looks up their row in admin_users (never trusts a role/user_id sent
 * in the request body). super_admin satisfies a 'support' check; support
 * does not satisfy a 'super_admin' check. Denials are logged to
 * security_events for the same reason every other privileged check in this
 * codebase logs its denials — a repeated pattern here is a signal worth
 * seeing on the monitoring dashboard, not just a silent 403.
 */
export async function requireAdmin(
  req: Request,
  minRole: AdminRole = "support",
): Promise<{ userId: string; email: string | null; role: AdminRole }> {
  const db = adminClient();
  const user = await getAuthUser(req);
  if (!user) throw new AdminAuthError(401, "Unauthorized");

  const { data, error } = await db
    .from("admin_users")
    .select("role, disabled_at")
    .eq("user_id", user.id)
    .maybeSingle();

  const role = !error && data && !data.disabled_at
    ? (data.role as AdminRole)
    : null;

  if (!role || ROLE_RANK[role] < ROLE_RANK[minRole]) {
    await db.from("security_events").insert({
      user_id: user.id,
      event_type: "admin_auth_denied",
      severity: "warning",
      source: "admin-auth",
      metadata: { required_role: minRole, actual_role: role },
    });
    throw new AdminAuthError(403, "Not authorized");
  }

  // Applied only AFTER the role check passes, so a rejected caller can never
  // consume a legitimate admin's allowance, and the 403 path stays the
  // cheapest one. Every admin-* function inherits this by calling
  // requireAdmin, so there is no per-endpoint wiring to forget.
  const scope = scopeForRequest(req);
  const rate = await enforceRateLimit(db, scope, user.id, ADMIN_MAX_PER_MINUTE, 60, user.id);
  if (!rate.allowed) {
    await db.from("security_events").insert({
      user_id: user.id,
      event_type: "admin_rate_limited",
      severity: "warning",
      source: "admin-auth",
      metadata: { scope, max_per_minute: ADMIN_MAX_PER_MINUTE },
    });
    throw new AdminAuthError(429, "Too many requests. Please slow down and try again.");
  }

  return { userId: user.id, email: user.email ?? null, role };
}
