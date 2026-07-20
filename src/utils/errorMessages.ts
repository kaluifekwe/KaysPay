const GENERIC_FAILURE_MESSAGE = 'Something went wrong. Please try again.';

// A raw provider/network error (DNS failures, "client error", stack-trace-
// looking text, URLs with API keys in them, etc.) should never reach a
// user's screen — it means nothing to them and makes the app look broken.
// Anything that looks like this gets swapped for a plain, honest message
// instead of being shown as-is.
function looksTechnical(text: string): boolean {
  return (
    /https?:\/\//i.test(text) ||
    /\b(dns|http|fetch|client error|econnrefused|etimedout|timeout|exception|stack trace|apikey|api_key)\b/i.test(text) ||
    text.length > 100
  );
}

/**
 * Wraps a caught error's message before showing it to a user (Alert, inline
 * error text, etc.). Use this anywhere a raw `error.message` from a network
 * call, third-party SDK, or provider response might otherwise reach the
 * screen — never show technical/provider-internal text directly to a user.
 */
export function safeErrorMessage(error: unknown, fallback: string = GENERIC_FAILURE_MESSAGE): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const text = raw.trim();
  if (!text) return fallback;
  return looksTechnical(text) ? fallback : text;
}
