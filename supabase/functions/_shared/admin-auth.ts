import { adminClient, getAuthUser } from "./auth.ts";

export type AdminRole = "support" | "super_admin";

export class AdminAuthError extends Error {
  constructor(public readonly status: 401 | 403, message: string) {
    super(message);
  }
}

const ROLE_RANK: Record<AdminRole, number> = { support: 1, super_admin: 2 };

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

  return { userId: user.id, email: user.email ?? null, role };
}
