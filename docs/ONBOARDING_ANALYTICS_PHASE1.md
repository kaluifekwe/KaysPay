# KaysPay Onboarding Intelligence — Phase 1 Specification

## Scope

Phase 1 provides the privacy and ingestion foundation only. Mobile screen instrumentation,
admin funnel UI, campaign delivery, and AI are explicitly outside this phase.

## Funnel definition

| Stage | Entry event | Completion event | Principal failure event |
|---|---|---|---|
| App activation | `app_opened` | `onboarding_started` | — |
| Product onboarding | `onboarding_started` | `onboarding_skipped` or registration entry | — |
| Registration | `registration_started` | `account_created` | `registration_validation_failed` |
| Email verification | `email_verification_started` | `email_verified` | `email_verification_failed` |
| Security setup | account created | `pin_setup_completed` | — |
| First home | security setup | `home_viewed` | — |
| KYC | `kyc_started` | `kyc_completed` | `kyc_failed` |
| First funding | `funding_viewed` / `funding_started` | `first_funding_completed` | `funding_failed` |
| Activation | first funding | `first_purchase_completed` | — |

An installation counts once per funnel stage. Repeated attempts remain available for failure
and recovery analysis but must not inflate conversion totals.

## Event contract

Every event requires client-generated UUIDs for `event_id`, `installation_id`, and
`session_id`, plus `event_type` and `occurred_at`. `event_id` makes offline retries
idempotent. A batch contains at most 20 events and may be delayed by at most seven days.

Allowed context is limited to app/build version, platform, OS major version, broad network
type, locale, acquisition source, allowlisted failure code, and four bounded metadata keys.
Country may be populated from a trusted edge header without retaining the source IP. Region
is reserved in the schema but remains empty until a lawful, reliable coarse-region source is
approved; the app must not request GPS for this purpose.
Never send names, emails, phone numbers, GPS coordinates, IP addresses, PINs, OTPs,
passwords, NIN/BVN, account details, recipients, balances, amounts, provider payloads,
free-form errors, or message contents.

## Identity and privacy

- Pre-signup activity uses a cryptographically random installation UUID.
- The ingestion function derives authenticated identity from the JWT; it never accepts a user ID.
- Once linked to a customer, an installation cannot be reassigned.
- Direct table access is denied to anonymous and authenticated clients.
- Raw anonymous events expire after 90 days; linked raw events expire after 400 days.
- Long-term trend reporting must use non-identifying daily aggregates.
- Marketing consent is a separate future control. Analytics collection does not imply consent to marketing.

## Admin dashboard specification (future UI)

### Summary

- Unique app activations, registrations, verified accounts, KYC completions, first fundings, and first purchases.
- Step-to-step and overall conversion.
- Median and 75th-percentile time between stages.
- New versus returning installations.

### Diagnostics

- Abandonment count and rate by last completed stage.
- Failure codes ranked by affected installations, with recovery rate.
- Version comparison and release regression alerts.
- Breakdowns by date range, platform, app version, OS major, network type, country/region when available, locale, and acquisition source.
- Data-quality panel for delayed, duplicate, rejected, and unknown-version events.

### Customer view

Super admins may open a linked customer's sanitized journey timeline. Support access should
remain read-only and omit marketing eligibility. Anonymous journeys must remain aggregate-only.

### Segments prepared for later campaigns

- Registered but not verified after 1 hour.
- Verified but PIN setup incomplete after 1 hour.
- Home reached but KYC not started after 24 hours.
- KYC failed and not recovered after 24 hours.
- KYC completed but not funded after 72 hours.
- Funding started but not completed after 1 hour.
- Funded but no first purchase after 24 hours.

No segment may be contacted until the later campaign phase verifies current marketing consent,
suppression status, frequency limits, and an auditable human approval.

## Operational targets

- Ingestion must never block onboarding or financial operations.
- Mobile integration should queue locally, batch up to 20 events, retry with backoff, and cap storage.
- Dashboard queries should use daily aggregate tables rather than scanning raw events at scale.
- Alert if ingestion errors exceed 1%, events arrive without app version, or funnel volume changes abruptly.
