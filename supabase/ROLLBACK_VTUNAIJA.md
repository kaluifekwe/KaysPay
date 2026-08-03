# Rolling back the VTUnaija migration (airtime + data)

Written 2026-08-03, while Phase 1 (airtime + data) is fresh, per the VTUnaija
migration plan's rollback strategy: VTU.ng's client, catalog, and reconcile
code was deliberately left deployed-but-unreferenced (never deleted), so
rollback is two small steps, not a rebuild.

## 1. Revert routing in `supabase/functions/vtu-purchase/index.ts`

In `resolvePurchase()`:
- **Airtime case**: change `provider: "vtunaija"` back to `provider: "vtu_ng"`,
  `endpoint: "/topup/"` back to `"/airtime"`, and `providerPayload` back to
  `{ service_id: network, phone, amount: amount / KOBO }`.
- **Data case**: change `provider: "vtunaija"` back to `provider: "vtu_ng"`,
  `endpoint: "/data/"` back to `"/data"`, the catalog lookup back to
  `.from("vtung_data_catalog")` selecting `variation_id` instead of
  `data_plan_id`, and `providerPayload` back to
  `{ phone, service_id: network, variation_id: bundle.variation_id }`.

Easiest: `git revert` the "Add VTUnaija as airtime provider (Phase 1a)" and
"Add VTUnaija as data provider (Phase 1b)" commits, or manually restore those
two `resolvePurchase()` cases from before them.

## 2. Revert the client's catalog source

In `src/services/vtu.service.ts`'s `refreshDataBundles`, change the
`supabase.functions.invoke('vtunaija-data-catalog', ...)` call back to
`'vtu-data-catalog'`.

## 3. Re-enable the VTU.ng reconcile/catalog crons if they were ever unscheduled

They should NOT have been unscheduled during Phase 1 (the migration plan
deliberately keeps `vtu-reconcile-pending-orders` and
`vtung-data-catalog-sync` running throughout). If they were later
unscheduled once VTUnaija was confirmed stable, re-run the last-known-good
`cron.schedule(...)` blocks from migrations `043` (vtu-reconcile) and `065`
(vtung-data-catalog-sync) in a NEW migration — Supabase migrations are
forward-only, don't try to "undo" one.

## 4. Deploy and verify

`supabase functions deploy vtu-purchase`, then a real small airtime + data
purchase to confirm VTU.ng is handling traffic again.

Nothing about this rollback requires touching `vtunaija-reconcile`,
`vtunaija-data-catalog`, the `vtunaija_data_catalog` table, or the
`vtu_performance_metrics` CHECK constraint (migration 066) — they can stay in
place, idle, exactly like VTU.ng's own code did during Phase 1.
