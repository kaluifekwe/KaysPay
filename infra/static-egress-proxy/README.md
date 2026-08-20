# Static egress proxy for Wallet Transfer

Supabase Edge Functions have no static outbound IP — Deno Deploy hands out a
different address per invocation, confirmed in Supabase's own docs. Flutterwave's
Transfer API requires whitelisting the calling server's IP and cannot be
disabled. This app is a small authenticated forward proxy deployed on Fly.io
with a fixed egress IP: KaysPay's edge functions call this proxy, the proxy
calls Flutterwave, and Flutterwave sees one whitelisted IP every time.

Only Flutterwave's three hosts are reachable through it (`filter`), and it
requires basic-auth credentials nobody outside KaysPay's Supabase secrets has.

## Deploy (one-time)

```bash
fly auth login
fly launch --no-deploy --copy-config --name kayspay-static-egress
fly secrets set PROXY_USER=<pick-a-username> PROXY_PASS=<generate-a-strong-random-password> --app kayspay-static-egress
fly deploy --app kayspay-static-egress
fly ips allocate-egress --app kayspay-static-egress -r iad
```

`fly ips allocate-egress` prints the static IPv4 — that's the one to whitelist.

## Whitelist the IP

- Flutterwave dashboard → Settings → Whitelist IP → add the printed IPv4.
- (Optional, for consistency) Paystack dashboard → API Keys & Webhooks → add the same IP — not required today since Transfer's Paystack fallback isn't built yet, but doesn't hurt to add now.

## Point KaysPay at it

```bash
supabase secrets set STATIC_PROXY_URL="https://<PROXY_USER>:<PROXY_PASS>@kayspay-static-egress.fly.dev:443"
```

(`https://` here — Fly terminates TLS at its edge on port 443, confirmed working via a live end-to-end test through the proxy to Flutterwave's sandbox API.)

Until this secret is set, every Flutterwave call keeps using a plain direct
fetch exactly as before — `_shared/proxied-fetch.ts` only routes through the
proxy once `STATIC_PROXY_URL` exists, so nothing else can break in the
meantime.

## Cost

One static egress IPv4 is $3.60/mo, billed hourly. The VM itself (shared-cpu-1x,
256mb) fits well inside Fly's free monthly allowance for a low-traffic proxy.
