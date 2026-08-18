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

const CRON_SECRET = Deno.env.get("CRON_SECRET");

/**
 * Gate for Edge Functions that should ONLY ever be called by our own
 * pg_cron schedule, never by a user or the public internet — reconcile
 * sweeps and payroll-execute (see migration 034). `verify_jwt` isn't enough
 * here: the anon key that satisfies it is meant to be public (it ships
 * inside the app bundle), so it doesn't actually restrict who can trigger
 * these. This checks a separate secret that pg_cron sends via a custom
 * header, sourced from Supabase Vault so it's never committed to git.
 */
export function verifyCronSecret(req: Request): boolean {
  const provided = req.headers.get("x-cron-secret");
  if (!provided || !CRON_SECRET || provided.length !== CRON_SECRET.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < CRON_SECRET.length; i++) {
    diff |= provided.charCodeAt(i) ^ CRON_SECRET.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Wraps a cron sweep's body so two overlapping runs of the SAME job never
 * execute at once (see migration 038). Uses a plain table row, not a
 * Postgres session advisory lock — Edge Functions reach Postgres through
 * PostgREST's pooled connections, so an "acquire" and "release" call minutes
 * apart could land on different underlying connections, and a session lock
 * can only be released by the session that took it. A stuck advisory lock
 * would silently block every future run forever; this self-expires instead.
 *
 * Returns `{ skipped: true }` if another run currently holds the lock —
 * callers should treat that as a normal, healthy outcome, not an error.
 */
export async function withJobLock<T>(
  supabase: ReturnType<typeof adminClient>,
  jobName: string,
  fn: () => Promise<T>,
): Promise<T | { skipped: true; reason: "already_running" }> {
  const { data: acquired } = await supabase.rpc("try_acquire_job_lock", {
    p_job_name: jobName,
  });
  if (!acquired) return { skipped: true, reason: "already_running" };
  try {
    return await fn();
  } finally {
    await supabase.rpc("release_job_lock", { p_job_name: jobName });
  }
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

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
};

/** Atomic account/action limiter. Never use a carrier IP as the subject. */
export async function enforceRateLimit(
  supabase: ReturnType<typeof adminClient>,
  scope: string,
  subject: string,
  maxRequests: number,
  windowSeconds: number,
  userId: string | null = null,
): Promise<RateLimitResult> {
  const { data, error } = await supabase.rpc("enforce_abuse_rate_limit", {
    p_scope: scope,
    p_subject: subject,
    p_max_requests: maxRequests,
    p_window_seconds: windowSeconds,
    p_user_id: userId,
  });
  // Fail closed for protected/paid operations if the limiter is unavailable.
  // A temporary retry is safer than letting an abuse burst bypass controls.
  if (error || !data) {
    return { allowed: false, remaining: 0, retryAfterSeconds: 60 };
  }
  return {
    allowed: data.allowed === true,
    remaining: Number(data.remaining ?? 0),
    retryAfterSeconds: Number(data.retry_after_seconds ?? 0),
  };
}

export class RequestBodyError extends Error {
  constructor(public readonly status: 400 | 413, message: string) {
    super(message);
  }
}

/** Reject oversized JSON even when a request uses chunked transfer encoding. */
export async function readJsonBody<T = Record<string, unknown>>(
  req: Request,
  maxBytes = 16_384,
): Promise<T> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new RequestBodyError(413, "Request body too large");
  }
  const text = await req.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new RequestBodyError(413, "Request body too large");
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new RequestBodyError(400, "Invalid request body");
  }
}

export function getSessionId(req: Request): string | null {
  try {
    const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    if (!token) return null;
    const encoded = token.split(".")[1];
    const padded = encoded.replace(/-/g, "+").replace(/_/g, "/").padEnd(
      Math.ceil(encoded.length / 4) * 4,
      "=",
    );
    return String(JSON.parse(atob(padded))?.session_id || "") || null;
  } catch {
    return null;
  }
}

/** Revoked registered sessions cannot perform financial/identity actions. */
export async function isDeviceSessionAllowed(
  req: Request,
  supabase: ReturnType<typeof adminClient>,
  userId: string,
): Promise<boolean> {
  const sessionId = getSessionId(req);
  if (!sessionId) return true; // compatibility for legacy tokens without the claim
  const { data, error } = await supabase.rpc("is_device_session_revoked", {
    p_user_id: userId,
    p_session_id: sessionId,
  });
  return !error && data !== true;
}

/** Server-controlled provider switch. Missing/failed controls fail closed. */
export async function isServiceEnabled(
  supabase: ReturnType<typeof adminClient>,
  service: "vtu" | "esim" | "foreign_number" | "identity" | "nin_modification" | "transfer",
): Promise<boolean> {
  const { data, error } = await supabase.rpc("is_service_enabled", {
    p_service: service,
  });
  return !error && data === true;
}
