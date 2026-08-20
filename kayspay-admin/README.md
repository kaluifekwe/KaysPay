# KaysPay Admin

Internal admin panel — separate from the customer-facing Expo app in the
repo root, same Supabase project. See [`AGENTS.md`](../AGENTS.md) for the
security rules that govern this codebase too (no secrets committed, no
service-role key client-side, etc).

## Local development

```bash
cd kayspay-admin
npm install
cp .env.example .env.local   # fill in VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY
npm run dev
```

Both env values are the same **public anon key pair** the mobile app ships
with in its own `.env` — safe client-side. The service-role key is never
used here; every privileged action goes through an `admin-*` Supabase Edge
Function instead (see `supabase/functions/admin-*` and
`supabase/functions/_shared/admin-auth.ts` in the repo root).

## First-time setup (once per environment)

1. Apply migration `087_admin_panel_foundation.sql` and deploy the
   `admin-*` edge functions (see the repo root's normal
   `supabase db push` / `supabase functions deploy` workflow).
2. Open the deployed admin app and sign in with your existing KaysPay
   account (email + password — same account as the mobile app).
3. Since no admin exists yet, you'll see a one-time "Set up admin access"
   screen. Completing it makes that account the first super admin.
4. From then on, invite further admins from the **Admins** page (super
   admin only) — no more manual setup needed.

## Build

```bash
npm run build
```

Outputs static files to `dist/` — deployable to any static host.

## Deploying to `admin.kayspay.com.ng`

This repo's main site (`kayspay.com.ng`) is deployed to Netlify manually
today (no CI-connected auto-deploy), so this follows the same pattern:

1. In the Netlify dashboard, create a new site (or add a new domain to an
   existing one) and add `admin.kayspay.com.ng` as a custom domain — since
   `kayspay.com.ng`'s DNS already appears to be on Netlify DNS, this is
   likely just adding the subdomain in the dashboard, no external registrar
   change needed (verify this in the DNS settings before assuming it).
2. Set the site's environment variables (`VITE_SUPABASE_URL`,
   `VITE_SUPABASE_ANON_KEY`) in the Netlify dashboard, or build locally
   with `.env.local` set and drag-and-drop the resulting `dist/` folder —
   whichever matches how the main site is deployed today.
3. This step is the owner's own action in the Netlify account — not
   something to be scripted or automated from this repo.
