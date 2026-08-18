import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { storageHelpers, StorageKeys } from '../lib/mmkv';
import { AppTheme, THEMES, LightTheme } from '../constants/theme';

export type ThemeMode = 'light' | 'dark';

interface ThemeContextValue {
  theme: AppTheme;
  mode: ThemeMode;
  // False until the persisted preference has loaded — screens generally
  // don't need this, but it avoids a flash-to-default write racing a real
  // preference that's still being read from SecureStore.
  ready: boolean;
  setMode: (mode: ThemeMode) => void;
  toggleMode: () => void;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>('light');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    storageHelpers.getString(StorageKeys.THEME_MODE).then((saved) => {
      if (cancelled) return;
      if (saved === 'dark' || saved === 'light') setModeState(saved);
      setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    void storageHelpers.setString(StorageKeys.THEME_MODE, next);
  }, []);

  const toggleMode = useCallback(() => {
    setModeState((current) => {
      const next = current === 'dark' ? 'light' : 'dark';
      void storageHelpers.setString(StorageKeys.THEME_MODE, next);
      return next;
    });
  }, []);

  const value: ThemeContextValue = {
    theme: THEMES[mode],
    mode,
    ready,
    setMode,
    toggleMode,
  };

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/** Falls back to the light theme if called outside the provider (should
 * never happen — App.tsx mounts ThemeProvider at the root — but a screen
 * rendered in isolation, e.g. a future test, shouldn't crash over it). */
export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    return { theme: LightTheme, mode: 'light', ready: true, setMode: () => {}, toggleMode: () => {} };
  }
  return ctx;
}
