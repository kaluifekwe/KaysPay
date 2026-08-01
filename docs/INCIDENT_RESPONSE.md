# Kay's Pay incident response and recovery

## First response

1. Confirm the alert in `monitoring_alerts` and the latest aggregate snapshot in `monitoring_runs`.
2. Do not manually edit wallet balances or transaction states.
3. Preserve the affected transaction IDs, provider references, timestamps and function logs. Do not copy PINs, tokens, NIN/BVN values or full provider payloads into tickets or chat.
4. If customers could lose money, pause only the affected service using `service_controls`; leave unrelated services available.
5. Compare Kay's Pay transactions with the provider's authoritative order status and merchant-wallet statement.
6. Use the existing idempotent reconciliation/refund functions. Never run ad-hoc balance updates.

## Emergency service controls

Only a trusted operator using the Supabase SQL editor/service role may change these rows. All services default to enabled.

```sql
UPDATE public.service_controls
SET enabled = false, reason = 'incident reference', updated_at = now()
WHERE service = 'vtu'; -- vtu | esim | foreign_number | identity
```

Restore service only after provider status and reconciliation are healthy:

```sql
UPDATE public.service_controls
SET enabled = true, reason = NULL, updated_at = now()
WHERE service = 'vtu';
```

Record who approved the change, when it happened, the incident reference and the verification evidence. Never expose a service-role credential to the app.

## Alert triage

- `negative_wallets`: critical. Pause all money-moving services and investigate the wallet ledger before any correction.
- `duplicate_provider_refs`: critical. Pause the affected provider and compare both transactions with its statement.
- `stuck_vtu`: check both reconcile jobs and provider availability. Do not refund an accepted/processing order until its terminal status is authoritative.
- `stuck_foreign_numbers`: verify activation expiry and the foreign-number reconcile job.
- `stuck_identity`: identity work can legitimately take 24–48 hours; investigate only after the 72-hour threshold.
- `high_failure_rate`: compare by service/provider before pausing anything.
- `burst_accounts`: monitor-only fraud signal; do not freeze a customer without human review and supporting evidence.

## Database recovery

1. Confirm the Supabase project's backup/PITR entitlement and current retention in the dashboard before an incident occurs.
2. Perform a restore drill into an isolated non-production project at least quarterly.
3. Validate row counts, wallet invariants, migration history, RLS, function privileges and a sample of reconciled transactions.
4. Never point the production app at a drill database.
5. For production recovery, record the selected recovery timestamp and expected data-loss window, stop writes, restore, run integrity checks, redeploy matching Edge Functions, then reopen services gradually.

## Closure

Document impact, root cause, detection time, containment, recovery evidence and preventive actions. Keep financial records required for audit; keep operational monitoring snapshots for 90 days and daily summaries separately.
