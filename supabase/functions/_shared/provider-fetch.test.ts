import { fetchWithTimeout, ProviderTimeoutError } from "./provider-fetch.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("provider fetch returns successful responses", async () => {
  const response = await fetchWithTimeout(
    "https://provider.invalid/test",
    {},
    50,
    async () => new Response("ok", { status: 200 }),
  );
  assert(response.status === 200, "expected successful response");
});

Deno.test("provider fetch aborts at the configured deadline", async () => {
  let thrown: unknown;
  try {
    await fetchWithTimeout(
      "https://provider.invalid/slow",
      {},
      5,
      (_input, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      }),
    );
  } catch (error) {
    thrown = error;
  }
  assert(thrown instanceof ProviderTimeoutError, "expected a tagged provider timeout");
});

Deno.test("provider fetch deadline includes a stalled response body", async () => {
  let thrown: unknown;
  try {
    await fetchWithTimeout(
      "https://provider.invalid/stalled-body",
      {},
      5,
      (_input, init) => {
        let streamController: ReadableStreamDefaultController<Uint8Array>;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller;
            controller.enqueue(new TextEncoder().encode("partial"));
          },
        });
        init?.signal?.addEventListener("abort", () => streamController.error(new DOMException("Aborted", "AbortError")), { once: true });
        return Promise.resolve(new Response(body, { status: 200 }));
      },
    );
  } catch (error) {
    thrown = error;
  }
  assert(thrown instanceof ProviderTimeoutError, "stalled body must respect the provider deadline");
});

Deno.test("provider fetch preserves caller cancellation", async () => {
  const controller = new AbortController();
  const callerError = new Error("caller cancelled");
  const pending = fetchWithTimeout(
    "https://provider.invalid/cancel",
    { signal: controller.signal },
    100,
    (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(callerError), { once: true });
    }),
  );
  controller.abort(callerError);
  let thrown: unknown;
  try {
    await pending;
  } catch (error) {
    thrown = error;
  }
  assert(thrown === callerError, "caller cancellation must not be relabeled as a timeout");
});
