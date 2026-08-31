# Open items

Things identified but deliberately not done, so they are not lost. Last
updated 2026-08-31.

---

## Needs a decision or an account only the owner has

### Transfer is off but was advertised
`service_controls.transfer` has been `false` since 2026-08-29. The app now
hides it correctly (Home and TransferScreen both fail closed), and the
rewritten Play copy no longer mentions it. Decide whether to re-enable it or
leave it off — the store listing and the app should agree either way.

### Certificate pinning plugin
`plugins/withNetworkSecurityConfig.js` is present but **unreferenced** in
`app.json`. It was removed from the plugin list on 2026-08-31 because it broke
every build (`config.modRequest` read at plugin-invocation time, where it does
not exist) and, more seriously, emitted a pinning config with literal
placeholder pins. Android enforces pin-sets strictly, so a release carrying
those would have had every connection to `supabase.co` rejected.

Finishing it properly needs: real extracted pins, at least two per domain
(primary + backup), a rotation plan for when Supabase renews certificates, and
on-device testing. Otherwise delete the file.

### Screenshot protection on Sign Up step 2
`useSensitiveScreenProtection` was removed from `RegistrationScreen` outside
this session and is included in v25 at the owner's explicit instruction. It
means password and PIN entry is screenshottable. Recorded here so the choice
stays visible rather than becoming an accident.

### Firebase service account key cleanup
An unused private key was generated on 2026-08-31 (the pre-existing 27-day-old
key was used instead). Delete
`dispatchph-firebase-adminsdk-fbsvc-4df3bc91eb.json` from Downloads and revoke
it in Google Cloud Console — it is a live credential that can send push.

---

## Built, waiting on the owner

### v25 upload
Built and ready: `versionCode 25`, `runtimeVersion 1.0.2`, from commit
`095b5b6`. Carries push notifications for the first time, plus every fix from
2026-08-31. Check v24's review state before uploading, since it was still in
review after ~3 days.

### Play Store listing copy
Rewritten in `docs/play-store-listing.md`, checked against `service_controls`.
Ready to paste.

---

## Ready to build, approved in principle

### In-app review prompt — **highest leverage**
The app has one rating and it is self-submitted, which is effectively no
ranking signal. Play search is a larger install channel than web SEO here.

Design agreed 2026-08-31: after a **successful** transaction, an inline card
asks "Enjoying KaysPay?". "Yes" opens Google's native in-app rating dialog via
`expo-store-review`; "Not really" routes to support instead. The split matters
— prompting everyone would send unhappy users straight to the store, and with
one existing rating a couple of one-stars would do real damage.

Rules: successful transactions only; not before the third; at most once per ~90
days; never again after rating. Needs the `expo-store-review` dependency and a
store build (not OTA-able).

---

## Engineering debt worth clearing

### 48-hour reconcile blind spot
`crypto-buy-reconcile` sweeps pending orders aged 30 minutes to 48 hours. Past
48 hours they drop out silently with no alert — which is exactly how eight
stuck orders accumulated unnoticed. Needs a monitoring alert when an order ages
past the window.

### Eight stuck crypto Buy orders
Untouched deliberately. All show `fiat_received_at: null`, but that field is
set by a webhook this project has already seen fail silently with a 401, so a
null is not proof nobody paid. Needs a read-only `requeryOnRamp()` pass against
Quidax to establish which were genuinely unpaid **before** anything is closed.
The oldest (2026-08-19, 2,790 naira) is the known sub-3,000 case Quidax cannot
complete.

### Naira settlement balance is stranded
Customers can hold NGN in their Quidax sub-account from old conversions
(1,380.06 naira observed). Nothing can move it: the sweep's only caller is
`crypto-quidax-webhook`'s legacy sell path, which no longer runs now that Sell
settles off-ramp directly to bank. Quidax enabled sub-account withdrawals on
2026-08-30, so a path may now exist — but it needs testing, and the safe probe
is an invalid-amount withdrawal call, which reveals the permission without
moving money.

### Original data purchase failures never diagnosed
The Airtel and MTN data failures that opened this session were never explained.
No transaction row was created in either case, so they failed before reaching
the server. If customers still hit this it is a conversion leak on the core
product and outranks anything SEO.

---

## SEO, after the fixes shipped 2026-08-31

Backlinks are the binding constraint. The domain is days old with essentially
none, and no amount of on-page work substitutes. Realistic targets: Nigerian
startup directories, Product Hunt, Nairaland, owned social profiles, and a
pitch to Techpoint or TechCabal.

Content pages worth adding once the current three prove out: long-tail how-tos
("how to buy a JAMB PIN online", "how to pay Ikeja Electric online"). Cheap to
win, high intent, low competition.

Validate keyword direction against real data before investing further — Google
Keyword Planner, or Search Console's Performance report once impressions
accumulate, which shows what the site is already nearly ranking for.
