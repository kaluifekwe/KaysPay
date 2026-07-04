import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

/**
 * Resolve the authenticated user from the request's JWT.
 * supabase-js attaches the caller's access token as `Authorization: Bearer`
 * when invoking functions, so this is the trustworthy source of identity.
 * NEVER trust a user_id sent in the request body.
 */
export async function getAuthUser(req: Request) {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return null;

  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await client.auth.getUser();
  if (error || !data?.user) return null;
  return data.user;
}

/** Service-role client for privileged DB writes / RPC calls. */
export function adminClient() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Verifies that this specific request was just authorized by the PIN/
 * biometric step-up flow (see migration 021). A valid JWT alone is NOT
 * enough to move money — every purchase/withdrawal Edge Function must call
 * this immediately after getAuthUser() and BEFORE any wallet debit.
 */
export async function consumeAuthToken(
  supabase: ReturnType<typeof adminClient>,
  userId: string,
  token: unknown,
): Promise<boolean> {
  if (typeof token !== "string" || !token) return false;
  const { data, error } = await supabase.rpc("consume_transaction_auth_token", {
    p_user_id: userId,
    p_token: token,
  });
  return !error && data === true;
}
