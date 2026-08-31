const ALLOWED_SCHEMES = new Set(['https', 'http']);

export function isVerifiedUrl(url: string, allowedDomains: string[]): boolean {
  try {
    const parsed = new URL(url);
    if (!ALLOWED_SCHEMES.has(parsed.protocol.replace(':', ''))) return false;
    const hostname = parsed.hostname.toLowerCase();
    return allowedDomains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

export function isAppleInstallUrl(url: string): boolean {
  return isVerifiedUrl(url, ['apple.com', 'apps.apple.com', 'itunes.apple.com']);
}
