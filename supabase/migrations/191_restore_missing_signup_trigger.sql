-- Real production bug found 2026-09-02 while auditing the admin dashboard's
-- user counts: on_auth_user_created (the trigger that creates a public.users
-- row -- and, via on_user_created cascading, a wallet -- the instant someone
-- signs up) does not exist on the live database at all. Confirmed directly:
-- auth.users had 58 real signups, public.users had only 25 -- 33 people who
-- signed up between July and today were invisible to every admin tool and
-- had no profile row until (if ever) their first wallet funding self-healed
-- one via credit_wallet_funding (migration 009).
--
-- handle_new_user() and on_user_created (public.users -> wallets) were both
-- still intact and correct -- only the auth.users-side trigger was gone,
-- most likely dropped by a platform-level auth-schema reset that a plain
-- CREATE OR REPLACE FUNCTION (which migration 009 used to harden the
-- function body) never re-attaches, since the trigger itself is a separate
-- object.
--
-- create_user_wallet() (migration 083) had no ON CONFLICT guard. The
-- backfill below inserts into public.users, which fires on_user_created,
-- which would otherwise crash on any of the 33 who already got a wallet via
-- the credit_wallet_funding self-heal path -- hardened first so the backfill
-- (and every future insert) can never collide.

CREATE OR REPLACE FUNCTION public.create_user_wallet()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO wallets (user_id, balance)
  VALUES (NEW.id, 0.00)
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$;

-- Verbatim from migration 009 -- already correct, re-declared only so this
-- migration is a complete, self-contained record of the fix.
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.users (id, phone, pin_hash)
  VALUES (
    NEW.id,
    NULLIF(COALESCE(NEW.phone, NEW.raw_user_meta_data->>'phone', ''), ''),
    NULLIF(NEW.raw_user_meta_data->>'pin_hash', '')
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- The actual fix: this is the trigger that was missing.
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION handle_new_user();

-- Backfill the 33 (as of this writing) real signups that fell through the
-- gap. Fires on_user_created per row, so a wallet is created alongside each
-- profile -- ON CONFLICT DO NOTHING above means anyone who already
-- self-healed a wallet via credit_wallet_funding is left untouched.
INSERT INTO public.users (id, phone)
SELECT au.id, NULLIF(au.phone, '')
FROM auth.users au
LEFT JOIN public.users pu ON pu.id = au.id
WHERE pu.id IS NULL;

DO $$
DECLARE v_orphaned INT; v_trigger_exists BOOLEAN;
BEGIN
  SELECT count(*) INTO v_orphaned
  FROM auth.users au LEFT JOIN public.users pu ON pu.id = au.id
  WHERE pu.id IS NULL;
  IF v_orphaned > 0 THEN
    RAISE EXCEPTION 'SIGNUP_BACKFILL_INCOMPLETE: % auth.users rows still have no public.users row', v_orphaned;
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM pg_trigger WHERE tgname = 'on_auth_user_created' AND tgrelid = 'auth.users'::regclass AND NOT tgisinternal
  ) INTO v_trigger_exists;
  IF NOT v_trigger_exists THEN
    RAISE EXCEPTION 'SIGNUP_TRIGGER_ASSERTION_FAILED: on_auth_user_created is still missing';
  END IF;
END $$;
