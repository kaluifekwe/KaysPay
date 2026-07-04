# P0 Security Rollout — Server-Authoritative Money Layer

This change makes the wallet ledger tamper-proof. The client can no longer
move money or hold provider secrets; every credit/debit now happens in an
Edge Function via atomic, row-locked Postgres functions.

## What changed

| Area | Before | After |
|------|--------|-------|
| Wallet funding | Client called `addFunds()` after verify → **anyone could mint money** | `paystack-verify` credits server-side, idempotent on Paystack reference |
| VTU purchases | Client debited wallet + called provider with `EXPO_PUBLIC_` key | `vtu-purchase` Edge Function: JWT auth → atomic debit → provider call (server key) → auto-refund on failure |
| Withdrawals | `user_id` taken from request body → **drain anyone's wallet** | `paystack-transfer` derives user from JWT; atomic debit + record |
| Webhook | Signature check was `return !!signature` (fake) | Real HMAC-SHA512 verification + idempotent credit/refund |
| `run-sql` | Unauthenticated arbitrary SQL with service role | **Deleted** (+ `exec_sql` dropped in migration) |
| Pricing | Client sent the price | Server resolves price from `_shared/vtu-catalog.ts` |
| Provider keys | `EXPO_PUBLIC_*` (shipped in APK) | Server-only Supabase secrets |
| Transaction PIN | Plaintext in auth metadata + on device | bcrypt hash in a server-only `user_pins` table, rate-limited verify (migration 006) |

## Deploy order (IMPORTANT)

The migration revokes the client's write access to `wallets`/`transactions`.
If you apply it before the new functions + app build are live, the old app
will start failing. Deploy in this order:

1. **Set server secrets** (one-time):
   ```bash
   supabase secrets set PAYSTACK_SECRET_KEY=sk_xxx
   supabase secrets set VTU_NG_API_KEY=xxx
   ```
   `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` are injected automatically.

2. **Deploy Edge Functions**:
   ```bash
   supabase functions deploy paystack-init
   supabase functions deploy paystack-verify
   supabase functions deploy paystack-transfer
   supabase functions deploy paystack-webhook --no-verify-jwt
   supabase functions deploy vtu-purchase
   ```
   > `paystack-webhook` must be deployed with `--no-verify-jwt` — Paystack
   > calls it server-to-server with no Supabase JWT; it authenticates via the
   > HMAC signature instead.

3. **Configure the Paystack dashboard** webhook URL to point at the deployed
   `paystack-webhook` function and confirm the secret key matches.

4. **Apply the migrations**:
   ```bash
   supabase db push    # applies 005 + 006 + 007 + 008_kobo_money.sql
   ```
   Migration 006 (PIN hashing) needs no extra function deploy — its
   `set_user_pin` / `verify_user_pin` RPCs are called directly by the
   authenticated client.

5. **Ship the new app build** (the JS bundle that calls `vtu-purchase`, no
   longer calls `walletService.addFunds`, and sets/verifies the PIN via RPC).

## Post-deploy verification

- Fund ₦100 → balance increases exactly once (verify + webhook are idempotent).
- Replay the same Paystack reference → no second credit.
- Buy airtime with insufficient balance → declined, no debit.
- Force a provider failure → wallet auto-refunded, transaction marked `failed`.
- Attempt a direct client write (`supabase.from('wallets').update(...)`) → denied.
- POST a forged body to `paystack-webhook` without a valid signature → 401.
- Set a PIN, then verify: correct PIN → `valid:true`; 5 wrong PINs → `locked:true`
  with a `locked_until` ~15 min out; confirm the client cannot `SELECT` from `user_pins`.

## Transaction authorization (PIN + biometric) — DONE

Every spend now requires authorization before the wallet is touched, via
`TransactionAuthProvider` (`useTransactionAuth().authorize()`):

- Biometric (fingerprint/face) is offered first when enabled on the device;
  PIN entry is the fallback. PIN is verified server-side (`verify_user_pin`,
  rate-limited with lockout from migration 006).
- Gated screens: Airtime, Data, Bills (electricity), TV, Exam PINs, Withdraw.
- `ChangePinScreen` (Settings → Change PIN) re-authorizes, then sets a new
  hashed PIN. The Settings biometric toggle now persists real state.

This is **client-only** — no new migration or function. Deploy = ship the new
app build (migration 006 must already be applied for `verifyPIN` to work).

## Withdrawal idempotency — DONE

A double-tapped or retried withdrawal can no longer debit twice or fire two
Paystack transfers. The client (`WithdrawScreen`) sends a stable
`idempotency_key` per withdrawal intent (plus a synchronous in-flight guard);
`debit_for_withdrawal` (migration 007) returns the existing withdrawal on
replay instead of re-debiting, and `paystack-transfer` short-circuits without
calling Paystack again. Redeploy `paystack-transfer` + apply migration 007.

## Integer-kobo money — DONE

The wallet ledger is now stored and computed in **integer kobo** (BIGINT),
the fintech-standard way to avoid floating-point money bugs and to future-proof
FX / cents / percentage fees.

- Migration 008 converts `wallets.balance/locked_amount/available_balance`,
  `transactions.amount_ngn`, `withdrawals.amount_ngn`,
  `processed_payments.amount_ngn` from NUMERIC(naira) to BIGINT(kobo) (×100,
  exact) and rewrites the money RPCs to take/return kobo.
- Edge functions pass kobo to the RPCs. Paystack already uses kobo; the VTU
  provider (vtu.ng) gets naira, so `vtu-purchase` divides by 100 at that edge.
- The **client keeps working in naira**. Conversion happens only in the service
  layer: `koboToNaira` on read (`walletService`, `paystackService.verify/transfer`)
  and `nairaToKobo` on send (`vtuService` airtime/electricity,
  `paystackService` funding/transfer). Screens and `formatNaira` are unchanged.

**Deploy:** apply migration 008 (after 005–007) and redeploy `vtu-purchase`,
`paystack-verify`, `paystack-webhook`, `paystack-transfer`, then ship the app
build. Migration 008 is a type change on live money tables — back up / snapshot
the DB first, and run it in a maintenance window.

## Still outstanding (next increments — NOT in this change)
- **Withdrawal idempotency key** to fully prevent double-tap.
- **Integer-kobo money** end to end (avoid float rounding).
- **Dollar Cards / Foreign Numbers / Payroll**: UI exists, no backend yet.
