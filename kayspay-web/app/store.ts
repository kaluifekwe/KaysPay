/**
 * The live Google Play listing. Kept in one place so the homepage CTA,
 * the per-service page CTAs and the structured data can never drift apart
 * — the site previously said "coming soon" on every one of them for some
 * time after the app had actually shipped.
 */
export const PLAY_STORE_URL =
  'https://play.google.com/store/apps/details?id=com.kayspay.app';

export const ANDROID_PACKAGE = 'com.kayspay.app';

/**
 * Records a Play Store click before the browser leaves the page.
 *
 * Analytics only loads once a visitor accepts cookies, so gtag is often
 * genuinely absent — that is expected, not an error, and must never block
 * the navigation. Play Console's own acquisition report is the
 * consent-independent source of truth for installs; this event exists to
 * attribute which page on the site drove the click.
 */
export function trackStoreClick(location: string): void {
  try {
    const gtag = (window as unknown as { gtag?: (...args: unknown[]) => void }).gtag;
    gtag?.('event', 'play_store_click', {
      event_category: 'engagement',
      event_label: location,
      transport_type: 'beacon',
    });
  } catch {
    // never let analytics stop someone reaching the store
  }
}
