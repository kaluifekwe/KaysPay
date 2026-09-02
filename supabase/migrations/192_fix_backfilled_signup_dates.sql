-- Migration 191's backfill INSERT didn't set created_at, so it defaulted to
-- now() for all 33 backfilled rows -- correctly restoring their profiles,
-- but stamping every one of them as "joined today" and inflating the
-- dashboard's New users count by 33. auth.users.created_at is the real,
-- authoritative signup moment; syncing public.users.created_at to match it
-- is safe for every row, not just the backfilled ones -- a healthy row
-- created by the (now-working) trigger already matches within milliseconds,
-- so this is a no-op there and a real fix only where it actually drifted.
UPDATE public.users pu
SET created_at = au.created_at
FROM auth.users au
WHERE pu.id = au.id AND pu.created_at IS DISTINCT FROM au.created_at;
