import type { FetchImplementation } from "./provider-fetch.ts";

// Supabase Edge Functions run on Deno Deploy's shared IP pool — there is no
// static egress IP to whitelist on a provider's dashboard (confirmed in
// Supabase's own docs). Flutterwave's Transfer API requires IP whitelisting
// and cannot be called directly from here as a result (this is what parked
// Wallet Transfer on 2026-08-18 — see migration 130). The fix is routing
// those calls through a small authenticated forward proxy with a fixed
// egress IP (infra/static-egress-proxy/, deployed on Fly.io) instead of
// calling the provider directly.
//
// STATIC_PROXY_URL, e.g. "http://user:pass@kayspay-static-egress.fly.dev:443"
// — unset until the proxy is deployed and its credentials are set, so every
// existing Flutterwave call (funding, virtual accounts) keeps working
// exactly as before with a plain fetch until this is deliberately turned on.
const STATIC_PROXY_URL = Deno.env.get("STATIC_PROXY_URL");

let proxyClient: Deno.HttpClient | null = null;
function getProxyClient(): Deno.HttpClient | null {
  if (!STATIC_PROXY_URL) return null;
  if (!proxyClient) {
    proxyClient = Deno.createHttpClient({ proxy: { url: STATIC_PROXY_URL } });
  }
  return proxyClient;
}

/** Same FetchImplementation shape as global fetch — swap in wherever a call needs to leave from the static IP. */
export const proxiedFetch: FetchImplementation = (input, init) => {
  const client = getProxyClient();
  if (!client) return fetch(input, init);
  return fetch(input, { ...init, client } as RequestInit & { client: Deno.HttpClient });
};

export function isStaticProxyConfigured(): boolean {
  return !!STATIC_PROXY_URL;
}
