/**
 * Feature flags for services that are built but not currently offered to users.
 *
 * Setting a flag to `false` hides the feature everywhere in the app: its tab,
 * its navigation routes, and any onboarding/marketing copy that advertises it.
 * All screens, services and Edge Functions are left intact, so re-enabling a
 * service is a one-line change here — no rebuild of the integration required.
 *
 * NOTE: these flags only control the client UI. The corresponding Edge
 * Functions stay deployed and directly callable, and the database objects
 * (tables, RPCs, cron jobs) are untouched. That is intentional — it keeps the
 * feature reversible — but it means a flag is NOT a security control. Anything
 * that must be genuinely unavailable has to be disabled server-side as well.
 */
export const Features = {
  /** Betting account funding (VTUAfrica). Disabled 2026-07-18 — service not offered. */
  BETTING_ENABLED: false,

  /** Recurring airtime/data payroll (standing orders). Disabled 2026-07-18 — service not offered. */
  PAYROLL_ENABLED: false,
} as const;

export type FeatureKey = keyof typeof Features;
