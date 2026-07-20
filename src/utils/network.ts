import { supabase } from '../lib/supabase';

/**
 * Applied to every supabase.functions.invoke() call across the app. Without
 * this, a request on a slow/dropping Nigerian mobile connection can hang
 * indefinitely with no error and no way for the UI to recover — the screen
 * just sits on "Processing" forever. This caps that wait so the user always
 * gets a clear failure to retry from instead of a dead screen.
 */
export const SERVICE_CALL_TIMEOUT_MS = 25000;

/**
 * Races a promise against a timeout. Doesn't cancel the underlying request —
 * if it eventually succeeds server-side after we've given up waiting, that's
 * fine, since every purchase call is idempotency-keyed and safe to retry.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number = SERVICE_CALL_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Request timed out. Please check your connection and try again.')),
      ms,
    );
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

/**
 * Approximate remaining lifetime of a PIN/biometric step-up token once
 * authorize() resolves (server-side TTL is 180s — see migration 021's
 * transaction_auth_tokens). Retries stop well before that real expiry so
 * the last attempt doesn't land right as the server starts rejecting it —
 * at that point the user needs to re-authorize, not keep silently retrying.
 */
const AUTH_TOKEN_RETRY_BUDGET_MS = 150_000;
const RETRY_DELAY_MS = 3000;

function isNetworkLevelError(error: any): boolean {
  if (!error) return false;
  // FunctionsHttpError means our server DID respond (even a decline like
  // "Insufficient balance" is a definitive answer) — never retry that.
  // FunctionsFetchError/FunctionsRelayError mean the request never reached
  // us or never got a response back — exactly the "network blip" case.
  return error?.name === 'FunctionsFetchError' || error?.name === 'FunctionsRelayError';
}

/**
 * Looks up whether a purchase with this idempotency key already has a
 * recorded outcome. Critical correctness note (found via live testing
 * 2026-07-06): the PIN/biometric auth_token is single-use, and it gets
 * consumed the moment a request REACHES the server — before the
 * idempotency-protected debit logic even runs. That means if the original
 * request actually reached the server and completed, but the response was
 * lost on the way back (connection dropped), blindly resubmitting with the
 * same auth_token doesn't safely return "already succeeded" — it fails at
 * the token-consumption check with "re-authorization required", masking a
 * real success as a failure. This check lets us find out what really
 * happened BEFORE ever resubmitting, so we never resubmit a request whose
 * token might already be spent.
 */
async function checkIdempotentOutcome(
  idempotencyKey: string,
  table: string,
  keyColumn: string,
  existsOnly: boolean,
): Promise<{ outcome: 'completed' | 'pending' | 'failed' | 'not_found'; row: any }> {
  try {
    const { data } = await supabase
      .from(table)
      .select('*')
      .eq(keyColumn, idempotencyKey)
      .maybeSingle();
    if (!data) return { outcome: 'not_found', row: null };
    // Some rows this checks (e.g. a payroll mandate) don't have a
    // completed/pending/failed lifecycle at all — existing at all IS the
    // success signal, since creating that row is the entire action.
    if (existsOnly) return { outcome: 'completed', row: data };
    if (data.status === 'completed') return { outcome: 'completed', row: data };
    if (data.status === 'pending' || data.status === 'processing') return { outcome: 'pending', row: data };
    return { outcome: 'failed', row: data }; // refunded/failed — a definitive non-success outcome
  } catch {
    // Couldn't even check — treat as unresolved; caller falls back to a
    // fresh retry attempt, same as if nothing had been found.
    return { outcome: 'not_found', row: null };
  }
}

export interface InvokeWithRetryOptions {
  /**
   * Almost everything (NIN/BVN, eSIM, foreign numbers, payroll runs, VTU)
   * goes through the shared debit_for_service RPC, which records the
   * idempotency key at `metadata->>idempotency_key` on `transactions`. Bank
   * withdrawals are the one exception — they use debit_for_withdrawal and
   * their own `withdrawals` table with a plain top-level `idempotency_key`
   * column instead. Pass these overrides for that case.
   */
  table?: string;
  keyColumn?: string;
  onRetry?: (attempt: number) => void;
  /**
   * Set this when the looked-up row has no completed/pending/failed
   * lifecycle to read (e.g. a payroll mandate — creating the row IS the
   * whole action, there's nothing further to complete). Existing at all is
   * then treated as success.
   */
  existsOnly?: boolean;
  /**
   * Most Edge Functions here respond with `{ success: true, ... }` on
   * success, so that's the default synthetic shape returned when recovering
   * from an ambiguous failure. paystack-transfer is the one exception — it
   * mirrors Paystack's own `{ status: true, data: {...} }` convention
   * instead. `row` is whatever was found by idempotency key, in case the
   * caller needs a real field from it (e.g. payroll_id).
   */
  buildRecovered?: (outcome: 'completed' | 'pending', row: any) => any;
}

/**
 * Wraps an already PIN/biometric-authorized purchase call with automatic
 * recovery from ambiguous network failures (dropped connection, timeout) —
 * WITHOUT ever blindly resubmitting a request whose single-use auth_token
 * might already have been consumed by an earlier attempt that actually
 * reached the server and succeeded.
 *
 * On an ambiguous failure, this checks the real outcome by idempotency_key
 * BEFORE deciding what to do next:
 *   - already completed  -> report success, no resubmission
 *   - already pending    -> report pending, no resubmission
 *   - already failed     -> report that failure, no resubmission (the token
 *                           is spent either way; retrying can't help)
 *   - nothing recorded   -> the original attempt never reached the debit
 *                           step, so it's safe to actually retry
 *
 * A definite server response (even a decline like "Insufficient balance")
 * is never touched by any of this — that's handled by the normal error path
 * in the calling service function, same as before.
 *
 * `onRetry` lets the caller show "still trying…" feedback instead of a
 * silent multi-second stall that looks identical to the UI being frozen.
 */
export async function invokeWithRetry<T>(
  makeCall: () => Promise<{ data: T | null; error: any }>,
  idempotencyKey: string,
  options?: InvokeWithRetryOptions,
): Promise<{ data: any; error: any }> {
  const table = options?.table ?? 'transactions';
  const keyColumn = options?.keyColumn ?? 'metadata->>idempotency_key';
  const existsOnly = options?.existsOnly ?? false;
  const onRetry = options?.onRetry;
  const buildRecovered = options?.buildRecovered ?? ((outcome: 'completed' | 'pending') => ({ success: true, pending: outcome === 'pending' }));
  const startedAt = Date.now();
  let attempt = 0;

  for (;;) {
    let result: { data: T | null; error: any };
    try {
      result = await makeCall();
    } catch (e) {
      // Our own withTimeout() rejects rather than resolving with an error
      // tuple — treat that identically to a fetch-level failure.
      result = { data: null, error: e };
    }

    if (!result.error || !isNetworkLevelError(result.error)) return result;

    const { outcome, row } = await checkIdempotentOutcome(idempotencyKey, table, keyColumn, existsOnly);
    if (outcome === 'completed') return { data: buildRecovered('completed', row), error: null };
    if (outcome === 'pending') return { data: buildRecovered('pending', row), error: null };
    if (outcome === 'failed') {
      // The server already resolved this — it was declined/refunded, not
      // lost to the network. Say that plainly instead of surfacing the
      // stale network error, which would misleadingly suggest trying again
      // might help (the auth_token is spent either way, so it wouldn't).
      return {
        data: { success: false, error: 'This did not go through and any charge was already refunded.' } as any,
        error: null,
      };
    }

    // Nothing recorded — the original attempt never reached the debit step,
    // so the auth_token is (almost certainly) still unused. Safe to retry.
    attempt++;
    if (Date.now() - startedAt >= AUTH_TOKEN_RETRY_BUDGET_MS) return result;

    onRetry?.(attempt);
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
  }
}
