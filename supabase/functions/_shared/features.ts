/**
 * Server-side feature switches for services that are built but not currently
 * offered to users. Mirrors `src/constants/features.ts` on the client.
 *
 * The client flags hide a feature's UI; these ones make the feature genuinely
 * unavailable, so a caller holding a valid JWT cannot reach it by invoking the
 * Edge Function directly. Both sides must be flipped together to re-enable a
 * service — client-only is a UI change, not a control.
 *
 * Nothing is deleted when a flag is false: the handlers, database objects and
 * provider clients all stay in place, so re-enabling is a one-line change here
 * plus the matching client flag (and re-scheduling the payroll cron, see
 * migration 044).
 */
export const Features = {
  /** Betting account funding + name verification (VTUAfrica). Disabled 2026-07-18. */
  BETTING_ENABLED: false,

  /** Recurring airtime/data payroll (standing orders). Disabled 2026-07-18. */
  PAYROLL_ENABLED: false,
} as const;

/** Standard 503 body for a service that is switched off. */
export const SERVICE_DISABLED_MESSAGE =
  "This service is not available at the moment.";
