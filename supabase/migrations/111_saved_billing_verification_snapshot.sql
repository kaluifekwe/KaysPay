-- Cache the parts of a TV/electricity verification that the customer reads
-- before paying, so tapping a saved smartcard shows the full picture at once.
--
-- Today only the customer name is stored, so the due date and renewal amount
-- can come from nowhere but a live provider call. Measured against four real
-- saved cards (3 samples each), that call takes ~1.0-1.4s typically and up to
-- ~3.6s on a cold connection, server-to-provider — the customer additionally
-- pays their own mobile latency on top. It lands at the exact moment they have
-- chosen a card and are ready to pay.
--
-- Deliberately NOT cached: current bouquet and account status. VTUnaija returns
-- Current_Bouquet as an empty string and Full_Details.Status as null on every
-- card checked, so columns for them would only ever hold blanks.
--
-- This cache speeds up DISPLAY only. vtu-purchase still refuses any
-- verification older than 5 minutes and re-verifies, so a stale figure here can
-- never authorise a charge.

ALTER TABLE public.saved_billing_accounts
  -- The provider sends this as a plain date-time string ("2026-09-09T00:00:00").
  ADD COLUMN IF NOT EXISTS due_date TIMESTAMPTZ,
  -- Kobo, matching every other money column in this schema. The provider
  -- reports naira as a STRING ("5800"), so whatever writes this must multiply
  -- by 100 — getting that wrong shows the customer a figure 100x out on the
  -- screen where they decide to pay.
  ADD COLUMN IF NOT EXISTS renewal_amount_kobo BIGINT
    CHECK (renewal_amount_kobo IS NULL OR renewal_amount_kobo >= 0);

COMMENT ON COLUMN public.saved_billing_accounts.due_date IS
  'Next renewal date last reported by the provider. Display only; never used to authorise a charge.';
COMMENT ON COLUMN public.saved_billing_accounts.renewal_amount_kobo IS
  'Renewal amount in KOBO. The provider reports naira as a string; multiply by 100 on write.';
