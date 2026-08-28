# Google Play Data Safety Review — KaysPay 1.0.2

Prepared: 27 August 2026

This checklist documents the recommended declarations for the KaysPay Android release. It is a review aid, not legal advice. The Play Console form must describe the entire production app and every enabled third-party SDK, not only the new operational analytics feature.

## Recommended high-level answers

- Does the app collect or share required user-data types? **Yes — collects data.**
- Is user data encrypted in transit? **Yes**, provided all production endpoints remain HTTPS-only.
- Can users request deletion? **Yes**, through the in-app/account process or `support@kayspay.com.ng`, subject to legally required financial-record retention.
- Does the app sell user data? **No.**
- Does the app share the analytics data with third parties? **No**, if Supabase and other infrastructure providers process it solely as contracted service providers. Confirm the applicable agreements before submitting.

## New operational analytics declarations

| Play data type | Collected | Shared | Purpose | Processing notes |
|---|---:|---:|---|---|
| App activity — app interactions | Yes | No | Analytics; app functionality | Onboarding, registration, verification, KYC and funding step events and success/failure status. |
| Device or other IDs | Yes | No | Analytics; app functionality | Random installation and session UUIDs; not an advertising ID. |
| Personal info — user IDs | Yes | No | Analytics; account management | Supabase account ID is associated server-side after authentication. |
| Location — approximate location | Yes | No | Analytics | Country code may be inferred by infrastructure from the request; the source IP address is not retained by the analytics table. |
| App info and performance — diagnostics | Yes | No | Analytics; app functionality | Sanitized failure codes plus app/build version, platform and OS major version. |

These analytics are automatically collected while the feature is enabled, so do not describe them as optional unless an effective in-app opt-out is implemented and honoured before collection.

## Data intentionally excluded from operational analytics

The analytics implementation must not transmit names, email addresses, phone numbers, PINs, passwords, OTPs, NIN/BVN values, identity documents, wallet balances, transaction amounts, bank details, recipient details, contact-book entries, precise location, advertising IDs, or free-form error messages.

## Retention and deletion

- Unlinked/anonymous operational events: up to 90 days.
- Account-linked operational events: up to 400 days.
- Account and financial transaction data may use different retention periods required by Nigerian law and must be declared separately where the Play form asks about those data types.
- A deletion request must remove eligible analytics data and other personal data while preserving records that must legally be retained.

## Required pre-submission checks

1. Review every permission and every production SDK against the Play form, including contacts, notifications, payments, KYC and crash/error reporting.
2. Confirm service-provider status and contractual processing terms for Supabase and all production vendors before selecting “not shared.”
3. Confirm the public policy at `https://kayspay.com.ng/privacy/` matches the released app.
4. Do not select “optional” for automatically collected analytics.
5. Revisit this declaration whenever a new SDK, provider, permission, advertising feature, or data field is added.
