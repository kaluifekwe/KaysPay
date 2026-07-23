# Releasing updates to Kay's Pay

How to ship changes to the live app **without breaking users who are mid-update.**
Kay's Pay is Expo + EAS, so you have two release paths.

---

## TL;DR

| You changed... | Do this | Live in |
|---|---|---|
| JS / UI / text / prices / logic / images (files under `src/`) | `eas update` (OTA) | **Minutes** |
| A native thing: new permission, native module, SDK bump, app icon/splash, anything in `app.json` `android`/`ios`/`plugins` | `eas build` → upload AAB → Play Store | Hours–1 day |
| Backend only (Supabase function or migration) | `supabase functions deploy` / `db push` | **Instantly, no app update** |

**Rule of thumb:** only touched `src/`? → OTA. Touched native config or added a native package? → new build.

---

## Path 1 — OTA update (most changes)

Pushes new JavaScript straight to installed apps. No Google review. Users get it on their **next app open**.

Config already in place: `app.json` → `updates.url`, `runtimeVersion.policy = "appVersion"`; channels `preview` and `production` (see `eas.json`).

**Always test on `preview` first, then promote to `production`:**

```bash
# 1. Test channel — install the internal/preview build and verify
eas update --branch preview --message "test: <what changed>"

# 2. Looks good? Ship to everyone
eas update --branch production --message "<what changed>"
```

Roll back a bad production update instantly (users recover on next open):

```bash
eas update:republish --branch production   # re-publish a previous good update
# or, to fall back to the JS baked into the installed build:
eas update:roll-back-to-embedded --branch production
```

---

## Path 2 — New build (native changes)

Needed when JS alone can't carry the change: new permission, a package with native code (e.g. `expo-notifications`), an SDK/Expo upgrade, or a new app icon/splash.

```bash
eas build --platform android --profile production
```

`production` auto-increments `versionCode`. Then in **Play Console**:

1. Create a release in **Internal testing** first → install → verify on a real device.
2. Promote to **Production** with a **staged rollout**: 10% → 50% → 100% over a day or two.
3. If something's wrong, **halt the rollout** before it reaches everyone.

---

## The guardrail: runtimeVersion (why OTA can't crash old installs)

An OTA update only reaches builds whose **runtimeVersion matches**. Yours is the app version (`1.0.0`).

- Pure JS change → runtimeVersion unchanged → OTA is safe for existing installs. ✅
- Native change → bump `version` in `app.json` → **new runtimeVersion** → those installs won't pull JS that needs native code they don't have. EAS enforces this for you. 🛡️

So: **never ship JS via OTA that depends on native code an old build doesn't have.** If a feature needs both, it's a **new build**, not an OTA.

---

## The fintech rule: backend changes must be backward-compatible

Money logic lives on the server (Supabase functions + DB), and users take days to update — so **old and new app versions call your backend at the same time.** Breaking that contract is how live users get errors.

- ✅ **Additive** changes are safe: new column, new function, new optional field. Old apps ignore them.
- ❌ **Breaking** changes hurt: renaming/deleting a column or function an old app still calls; making a previously-optional field required.
- When a breaking change is unavoidable, do it in phases:
  1. Ship the **backend** change that supports **both** old and new behaviour.
  2. Roll out the **app** update.
  3. Wait until almost everyone has updated (check Play Console adoption).
  4. **Then** remove the old backend path.

---

## Standard release checklist

- [ ] Change committed locally; secret-scan the diff before any `git push`.
- [ ] JS-only? → `eas update --branch preview`, test, then `--branch production`.
- [ ] Native? → `eas build --profile production` → Internal testing → staged rollout.
- [ ] Backend change is **additive / backward-compatible** (or phased as above).
- [ ] Verified on a real device before production.
- [ ] Know the rollback: `eas update:republish` (OTA) or halt the Play staged rollout (build).
