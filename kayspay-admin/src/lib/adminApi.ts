import { supabase } from './supabase';

export class AdminApiError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
  }
}

/**
 * Thin wrapper over supabase.functions.invoke — it already attaches the
 * current session's access token as the Authorization header, which is
 * what every admin-* edge function's requireAdmin() checks. Query params
 * are appended to the function name itself since invoke() doesn't have a
 * dedicated query option.
 */
export async function callAdmin<T = unknown>(
  name: string,
  opts: { method?: 'GET' | 'POST'; body?: Record<string, unknown>; query?: Record<string, string> } = {},
): Promise<T> {
  const { method = 'GET', body, query } = opts;
  const qs = query
    ? '?' + new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== '')).toString()
    : '';

  const { data, error } = await supabase.functions.invoke(name + qs, {
    method,
    body: method === 'POST' ? body ?? {} : undefined,
  });

  if (error) {
    // FunctionsHttpError carries the actual response; try to surface the
    // server's own { error: "..." } message rather than a generic one.
    const context = (error as { context?: Response }).context;
    if (context) {
      let parsed: { error?: string } | null = null;
      try {
        parsed = (await context.clone().json()) as { error?: string };
      } catch {
        // The response was not JSON; fall through to the SDK message below.
      }
      if (parsed?.error) {
        throw new AdminApiError(parsed.error, context.status);
      }
    }
    throw new AdminApiError(error.message);
  }

  const payload = data as { success?: boolean; error?: string } & T;
  if (payload && payload.success === false) {
    throw new AdminApiError(payload.error || 'Request failed');
  }
  return payload;
}
