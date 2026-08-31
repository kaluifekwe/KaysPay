import type { MetadataRoute } from "next";

export const dynamic = "force-static";

/**
 * next.config sets trailingSlash: true, so every real URL on this site
 * ends in "/" and every canonical tag emits one. The sitemap previously
 * listed them WITHOUT the slash, which advertised a different address to
 * Google than the canonical claimed — the classic cause of "Duplicate,
 * Google chose a different canonical" in Search Console, and it splits
 * ranking signals across two forms of the same page. These must match.
 */
const paths = [
  "",
  "services",
  "airtime-data",
  "electricity-bills",
  "tv-subscriptions",
  "exam-pins",
  "travel-esim",
  "identity-services",
  "crypto-services",
  "security",
  "about",
  "help",
  "contact",
  "privacy",
  "delete-account",
];

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();
  return paths.map((path) => ({
    url: `https://kayspay.com.ng/${path ? `${path}/` : ""}`,
    lastModified,
    changeFrequency: path ? "monthly" : "weekly",
    priority: path ? 0.7 : 1,
  }));
}
