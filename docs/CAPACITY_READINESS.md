# Capacity and resilience readiness

## What Phase 6 establishes

- External provider calls have hard deadlines. A slow upstream cannot hold an Edge Function indefinitely.
- Financial POST requests are not automatically retried by the provider client. Only higher-level flows with a proven idempotency key may retry.
- Transaction monitoring and reconciliation queries use composite status/type/time indexes.
- Profile statistics are aggregated in Postgres instead of downloading up to 1,000 financial records to a phone.
- A local-only load harness exercises concurrency, latency, timeouts, retryable failures, and idempotency keys without contacting production or paid providers.

## Safe local test

```bash
npm run load:test -- --requests=30000 --concurrency=300
```

The harness refuses non-local targets. It validates the test machinery and client failure assumptions; it does **not** certify Supabase or a VTU provider for 30,000 simultaneous requests.

## What must be measured before claiming 30,000 concurrent users

1. Use a separate Supabase staging project with production-equivalent compute, database size, RLS, indexes, and Edge Functions.
2. Use provider sandbox credentials or deterministic mocks. Never call paid airtime/data order endpoints during load testing.
3. Ramp gradually: 100, 500, 1,000, then the agreed peak. Stop on wallet-integrity alerts, database saturation, provider throttling, or elevated 5xx responses.
4. Measure p50/p95/p99 latency, Edge Function concurrency, database CPU/IOPS/connections, lock wait time, rate-limit rejects, reconciliation lag, and provider quota responses.
5. Run a 60-minute soak test and verify every accepted idempotency key maps to exactly one wallet debit and one transaction.

## Current capacity conclusion

The application is architecturally safer for a **30,000 registered/active-user population**, but no responsible engineer should claim **30,000 simultaneous purchase requests** until staging measurements and provider quotas prove it. Supabase plan limits, database compute, Realtime connections, and each Nigerian VTU provider's rate limits are external capacity gates.

## Production guardrails

- Keep purchase rate limits enabled and tune them from observed legitimate traffic.
- Use the Phase 5 service controls during provider incidents.
- Treat timeouts as ambiguous outcomes and reconcile by idempotency/provider reference; never immediately refund an unconfirmed provider order.
- Scale provider concurrency below documented quotas and prefer queues for large bulk workloads.
