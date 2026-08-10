// Shared date/time formatting for on-screen UI (not receipts — see
// utils/receipts.ts for the printed-HTML equivalent, which stays separate).
// en-GB locale matches the convention already used throughout the app.

function formatTime12h(date: Date): string {
  const hours = date.getHours();
  const minutes = date.getMinutes().toString().padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  const formattedHours = hours % 12 || 12;
  return `${formattedHours}:${minutes} ${ampm}`;
}

// "4 August 2026 · 2:32 PM" — long month, for detail views.
export function formatDateTimeFull(iso: string): string {
  const date = new Date(iso);
  const day = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  return `${day} · ${formatTime12h(date)}`;
}

// "4 Aug 2026 · 2:32 PM" — short month, for list rows.
export function formatDateTimeShort(iso: string): string {
  const date = new Date(iso);
  const day = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  return `${day} · ${formatTime12h(date)}`;
}

// "2 mins ago" / "3 hours ago" / "5 days ago" while genuinely recent (< 7
// days old); null once older, so callers fall back to an explicit date
// instead of degrading to a vague label.
export function relativeLabel(iso: string): string | null {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  const s = Math.max(1, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min${m > 1 ? 's' : ''} ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hour${h > 1 ? 's' : ''} ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d} day${d > 1 ? 's' : ''} ago`;
  return null;
}
