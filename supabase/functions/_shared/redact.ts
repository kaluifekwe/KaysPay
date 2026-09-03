// Strips secrets from any string before it is LOGGED or PERSISTED. Low-level
// fetch/DB errors can embed a request URL (with an apikey query param), an
// Authorization: Bearer token, or a raw key — none of which may ever reach the
// client, the DB (user-readable rows), or the logs. Route every error string
// that gets logged or stored through this first.
export function redactSecrets(input: unknown): string {
  let s = typeof input === "string"
    ? input
    : String((input as { message?: unknown })?.message ?? input ?? "");
  // apikey / token / secret / password carried as a query param
  s = s.replace(
    /([?&](?:apikey|api_key|token|secret|password|pass|key)=)[^&\s)"']+/gi,
    "$1***",
  );
  // bare "apikey=..." not preceded by ? or & (e.g. mid-URL from some runtimes)
  s = s.replace(/\bapikey=[^&\s)"']+/gi, "apikey=***");
  // Authorization: Bearer <token>
  s = s.replace(/(Bearer\s+)[A-Za-z0-9._\-]+/gi, "$1***");
  // secret_hash / secret_key style assignments in JSON or text
  s = s.replace(
    /(\b(?:secret(?:_?hash|_?key)?|api[_-]?key)\b["']?\s*[:=]\s*["']?)[^\s"',}]+/gi,
    "$1***",
  );
  // Financial/identity credentials and identifiers in structured error text.
  s = s.replace(
    /(\b(?:pin|password|newPassword|nin|bvn|auth_token|access_token|refresh_token)\b["']?\s*[:=]\s*["']?)[^\s"',}]+/gi,
    "$1***",
  );
  // Email addresses in free text -- the key:value pass above only catches
  // "email: x@y.com"; a provider's own prose (e.g. a validation error that
  // echoes the address back) needs this separate, unanchored pass.
  s = s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[redacted-email]");
  return s;
}
