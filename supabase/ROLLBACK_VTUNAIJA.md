# Rolling back the VTUnaija migration (airtime, data, electricity, TV)

Written 2026-08-03, updated same day after Phase 2 (electricity + TV), per the
VTUnaija migration plan's rollback strategy: VTU.ng's and VTUAfrica's client,
catalog, and reconcile code was deliberately left deployed-but-unreferenced
(never deleted), so rollback is a small routing change per service, not a
rebuild. Exam PINs were never moved (still on VTUAfrica), so nothing to revert
there.

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
- **Electricity case**: change `provider: "vtunaija"` back to
  `provider: "vtuafrica"`, `endpoint: "/billpayment/"` back to `"/electric"`,
  drop the `vtunaija_electricity_catalog` lookup, and `providerPayload` back to
  `{ service: biller, meterNo: meter, metertype: type, amount: amount / KOBO }`.
- **TV case**: change `provider: "vtunaija"` back to `provider: "vtuafrica"`,
  `endpoint: "/cablesub/"` back to `"/paytv"`, the catalog lookup back to the
  static `TV_BOUQUETS[bouquetId]` map (re-add that import), and
  `providerPayload` back to
  `{ service: bouquet.serviceId, smartNo: smartcard, variation: bouquet.variationCode, maxamount: bouquet.amount / KOBO }`.
  Amount also reverts to `bouquet.amount` (kobo) instead of `bouquet.reseller_kobo`.

Easiest: `git revert` the relevant Phase 1a/1b/2 commits, or manually restore
those `resolvePurchase()` cases from before them.

## 2. Revert the client's catalog sources

- In `src/services/vtu.service.ts`'s `refreshDataBundles`, change the
  `supabase.functions.invoke('vtunaija-data-catalog', ...)` call back to
  `'vtu-data-catalog'`.
- **TV specifically needs a client revert, not just a routing flip**:
  `TVScreen.tsx` was converted from a static `tvProviders[].bouquets` list to
  a live fetch (`vtuService.getBouquets`/`refreshBouquets` calling
  `vtunaija-cabletv-catalog`). Reverting the server routing alone would leave
  the client fetching VTUnaija-shaped bouquet ids while the server expects
  VTUAfrica's — revert `TVScreen.tsx` and `vtu.service.ts`'s TV-related code
  together with the server change (they must move as one unit), restoring the
  static `tvProviders` array with embedded bouquets.
- Electricity needs no client change either way — `ElectricityPayScreen.tsx`
  never referenced a provider-specific catalog, so only the server side ever
  changed for it.

## 3. Re-enable the VTU.ng/VTUAfrica reconcile/catalog crons if they were ever unscheduled

They should NOT have been unscheduled during Phase 1/2 (the migration plan
deliberately keeps `vtu-reconcile-pending-orders`, `vtung-data-catalog-sync`,
and VTUAfrica's reconcile running throughout). If they were later unscheduled
once VTUnaija was confirmed stable, re-run the last-known-good
`cron.schedule(...)` blocks from migrations `043` (vtu-reconcile), `065`
(vtung-data-catalog-sync), and `056` (vtuafrica-reconcile) in a NEW migration —
Supabase migrations are forward-only, don't try to "undo" one.

## 4. Deploy and verify

`supabase functions deploy vtu-purchase`, then a real small purchase per
reverted service to confirm the old provider is handling traffic again.

Nothing about this rollback requires touching any `vtunaija-*` reconcile or
catalog function/table, or the `vtu_performance_metrics` CHECK constraint
(migration 066) — they can stay in place, idle, exactly like VTU.ng's/
VTUAfrica's own code did during Phase 1/2.
