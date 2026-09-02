-- Real bug found 2026-09-02 investigating why welcome emails greet
-- customers generically instead of by name: handle_new_user() has only
-- ever copied phone and pin_hash from auth.users into public.users -- full_name
-- was collected at every signup (RegistrationScreen.tsx) and is sitting
-- safely in auth.users.raw_user_meta_data for all 58 real accounts, it was
-- just never copied into the row welcome-email (and anything else that
-- greets someone by name) actually reads. Confirmed: only 1 of 59
-- public.users rows had full_name set before this migration.

CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.users (id, phone, pin_hash, full_name)
  VALUES (
    NEW.id,
    NULLIF(COALESCE(NEW.phone, NEW.raw_user_meta_data->>'phone', ''), ''),
    NULLIF(NEW.raw_user_meta_data->>'pin_hash', ''),
    NULLIF(trim(NEW.raw_user_meta_data->>'full_name'), '')
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Backfill every existing account's real name from their own signup
-- record -- fully recoverable, nothing guessed.
UPDATE public.users pu
SET full_name = NULLIF(trim(au.raw_user_meta_data->>'full_name'), '')
FROM auth.users au
WHERE pu.id = au.id
  AND pu.full_name IS NULL
  AND NULLIF(trim(au.raw_user_meta_data->>'full_name'), '') IS NOT NULL;
