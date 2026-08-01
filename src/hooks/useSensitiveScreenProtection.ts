import { useEffect } from 'react';
import * as ScreenCapture from 'expo-screen-capture';

/** Blocks screenshots/recording only while a sensitive screen is mounted. */
export function useSensitiveScreenProtection(): void {
  useEffect(() => {
    const key = `kayspay-sensitive-${Date.now()}-${Math.random()}`;
    void ScreenCapture.preventScreenCaptureAsync(key);
    return () => {
      void ScreenCapture.allowScreenCaptureAsync(key);
    };
  }, []);
}
