export class ProviderTimeoutError extends Error {
  readonly code = "PROVIDER_TIMEOUT";

  constructor(readonly timeoutMs: number) {
    super(`Provider request exceeded ${timeoutMs}ms`);
    this.name = "ProviderTimeoutError";
  }
}

export type FetchImplementation = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

/**
 * Bounds an external-provider request without retrying it. Financial POSTs
 * must only be retried by callers that can prove provider idempotency.
 */
export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = 20_000,
  fetchImpl: FetchImplementation = fetch,
): Promise<Response> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new RangeError("timeoutMs must be between 1 and 120000");
  }

  const controller = new AbortController();
  const upstreamSignal = init.signal;
  const forwardAbort = () => controller.abort(upstreamSignal?.reason);
  if (upstreamSignal?.aborted) forwardAbort();
  else upstreamSignal?.addEventListener("abort", forwardAbort, { once: true });

  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(input, { ...init, signal: controller.signal });
    // Buffer inside the deadline. Native fetch resolves when headers arrive;
    // without this, a provider could send headers and then stall the body.
    const body = await response.arrayBuffer();
    return new Response(body.byteLength > 0 ? body : null, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (error) {
    if (controller.signal.aborted && !upstreamSignal?.aborted) {
      throw new ProviderTimeoutError(timeoutMs);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    upstreamSignal?.removeEventListener("abort", forwardAbort);
  }
}
