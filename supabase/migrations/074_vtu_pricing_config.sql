-- Runtime-switchable resale pricing tier for VTUnaija data + exam pins.
-- VTUnaija's own price list exposes two tiers per plan: "premium" (our real
-- billed cost, confirmed via their dashboard 2026-08-03) and "basic" (their
-- suggested retail price, always >= premium — the spread is pure margin for
-- us). Cable TV has no spread (basic == premium on every plan) so it isn't
-- included here; it stays hardcoded on price_for_premiumuser.
--
-- Launch decision (2026-08-03, owner-approved): sell at "premium" (cost) as a
-- promo for now, switch to "basic" later. This table is the switch — same
-- pattern as service_controls (migration 061): edit the `tier` column
-- directly in the Supabase Table Editor, no code change or redeploy needed.
-- vtunaija-data-catalog picks up a change on its next sync (every 5 min);
-- exam_pin pricing is read live per purchase, so it updates immediately.
CREATE TABLE IF NOT EXISTS public.vtu_pricing_config (
  product    TEXT PRIMARY KEY CHECK (product IN ('data', 'exam_pin')),
  tier       TEXT NOT NULL DEFAULT 'premium' CHECK (tier IN ('premium', 'basic')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO public.vtu_pricing_config (product, tier) VALUES
  ('data', 'premium'),
  ('exam_pin', 'premium')
ON CONFLICT (product) DO NOTHING;

ALTER TABLE public.vtu_pricing_config ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.vtu_pricing_config FROM PUBLIC, anon, authenticated;
GRANT SELECT, UPDATE ON public.vtu_pricing_config TO service_role;
