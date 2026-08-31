"use client";

import Script from "next/script";
import { useEffect, useState } from "react";

const CONSENT_KEY = "kayspay-analytics-consent";
const measurementId = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID;

type ConsentChoice = "accepted" | "rejected" | null;

declare global {
  interface Window {
    dataLayer: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

export default function AnalyticsConsent() {
  const [choice, setChoice] = useState<ConsentChoice>(null);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [draftEnabled, setDraftEnabled] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const stored = window.localStorage.getItem(CONSENT_KEY);
    const savedChoice = stored === "accepted" || stored === "rejected" ? stored : null;
    setChoice(savedChoice);
    setDraftEnabled(savedChoice === "accepted");

    const openFromHash = () => {
      if (window.location.hash === "#analytics-preferences") {
        setDraftEnabled(window.localStorage.getItem(CONSENT_KEY) === "accepted");
        setPreferencesOpen(true);
      }
    };
    openFromHash();
    window.addEventListener("hashchange", openFromHash);
    setReady(true);
    return () => window.removeEventListener("hashchange", openFromHash);
  }, []);

  useEffect(() => {
    if (choice !== "accepted") return;

    const trackCta = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const link = target.closest<HTMLAnchorElement>('a[href*="#download"]');
      if (!link || !window.gtag) return;
      window.gtag("event", "cta_click", {
        link_text: link.textContent?.trim().slice(0, 80) || "Download app",
        link_url: link.href,
      });
    };

    document.addEventListener("click", trackCta);
    return () => document.removeEventListener("click", trackCta);
  }, [choice]);

  const saveChoice = (nextChoice: Exclude<ConsentChoice, null>) => {
    window.localStorage.setItem(CONSENT_KEY, nextChoice);
    window.gtag?.("consent", "update", {
      analytics_storage: nextChoice === "accepted" ? "granted" : "denied",
    });
    setChoice(nextChoice);
    setDraftEnabled(nextChoice === "accepted");
  };

  const closePreferences = () => {
    setPreferencesOpen(false);
    if (window.location.hash === "#analytics-preferences") {
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    }
  };

  if (!ready) return null;

  return (
    <>
      {choice === "accepted" && measurementId ? (
        <>
          <Script
            src={`https://www.googletagmanager.com/gtag/js?id=${measurementId}`}
            strategy="afterInteractive"
          />
          <Script id="kayspay-google-analytics" strategy="afterInteractive">
            {`window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
window.gtag = gtag;
gtag('js', new Date());
gtag('config', '${measurementId}', { anonymize_ip: true });`}
          </Script>
        </>
      ) : null}

      {choice === null && !preferencesOpen ? (
        <section className="consent-banner" aria-label="Analytics preferences">
          <div>
            <strong>Help us improve KaysPay</strong>
            <p>Allow anonymous website statistics. We never send account, KYC, wallet, or transaction information. <a href="/privacy/#website-analytics">Learn more</a></p>
          </div>
          <div className="consent-actions">
            <button type="button" className="consent-reject" onClick={() => saveChoice("rejected")}>Not now</button>
            <button type="button" className="consent-accept" onClick={() => saveChoice("accepted")}>Allow</button>
          </div>
        </section>
      ) : null}

      {preferencesOpen ? (
        <div className="preferences-backdrop" role="presentation">
          <section className="preferences-panel" role="dialog" aria-modal="true" aria-labelledby="preferences-title">
            <strong id="preferences-title">Analytics preferences</strong>
            <p>Choose whether KaysPay may collect anonymous website statistics. Your current choice is shown below.</p>
            <label className="preference-row">
              <span><b>Google Analytics</b><small>Anonymous page views and website interactions</small></span>
              <input type="checkbox" checked={draftEnabled} onChange={(event) => setDraftEnabled(event.target.checked)} />
            </label>
            <div className="consent-actions">
              <button type="button" className="consent-reject" onClick={closePreferences}>Cancel</button>
              <button type="button" className="consent-accept" onClick={() => { saveChoice(draftEnabled ? "accepted" : "rejected"); closePreferences(); }}>Save preferences</button>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
