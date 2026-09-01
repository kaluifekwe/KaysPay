import { useCallback, useState } from 'react';

const PREFIX = 'kayspay_admin_hidden:';

function readStored(key: string): boolean {
  try {
    return localStorage.getItem(PREFIX + key) === '1';
  } catch {
    return false;
  }
}

// Backs both the Dashboard's per-figure hide toggle (profit, new users, etc.)
// and the Transactions page's single "hide all customer names" switch. Each
// gets its own key, and the on/off choice is remembered in this browser
// across reloads — useful for anyone regularly screen-sharing this
// dashboard who wants a figure to stay masked without re-hiding it every
// visit. Scoped to localStorage only: per-browser, never synced anywhere,
// never sent to the server.
export function useHidden(key: string): [boolean, () => void] {
  const [hidden, setHiddenState] = useState(() => readStored(key));
  const toggle = useCallback(() => {
    setHiddenState((prev) => {
      const next = !prev;
      try {
        if (next) localStorage.setItem(PREFIX + key, '1');
        else localStorage.removeItem(PREFIX + key);
      } catch {
        // best-effort; still works for the rest of this page view
      }
      return next;
    });
  }, [key]);
  return [hidden, toggle];
}

// Fixed-width regardless of the real value's length, so a hidden figure
// never leaks how many digits or characters it actually has. Same
// convention as the mobile app's own hidden-balance mask ('₦ ••••••').
export const HIDDEN_MASK = '••••••';
