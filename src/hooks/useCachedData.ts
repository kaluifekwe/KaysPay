import { useCallback, useEffect, useRef, useState } from 'react';
import { readCache, writeCache } from '../utils/cache';

export interface UseCachedDataResult<T> {
  data: T | null;
  loading: boolean;
  /** True if `data` is the last-known-good cached value, not a fresh fetch. */
  isStale: boolean;
  /** Only ever set when there's NO cached value to fall back on — otherwise
   * a failed refresh just quietly leaves the stale cached data on screen. */
  error: string | null;
  refresh: () => Promise<void>;
}

/**
 * Shows the last-known-good result immediately (if any was ever cached)
 * while fetching a fresh one in the background — instead of a blank/loading
 * screen every time, which on a bad Nigerian mobile connection can mean
 * staring at nothing for the full 25s timeout for data the app already had
 * five minutes ago.
 *
 * A failed refresh never overwrites good cached data with an error — it
 * just leaves the stale value on screen (`isStale` stays true). `error` is
 * only set when there was never anything to show in the first place.
 */
export function useCachedData<T>(key: string, fetchFn: () => Promise<T>): UseCachedDataResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [isStale, setIsStale] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Keeps `refresh` stable across renders even though the caller's fetchFn
  // is usually a fresh closure every render.
  const fetchFnRef = useRef(fetchFn);
  fetchFnRef.current = fetchFn;

  const load = useCallback(async () => {
    const cached = readCache<T>(key);
    if (cached) {
      setData(cached.data);
      setIsStale(true);
      setLoading(false);
    } else {
      setLoading(true);
    }

    try {
      const fresh = await fetchFnRef.current();
      setData(fresh);
      setIsStale(false);
      setError(null);
      writeCache(key, fresh);
    } catch (e) {
      if (!cached) {
        setError(e instanceof Error ? e.message : 'Could not load. Please try again.');
      }
      // else: leave the stale cached value showing — a background refresh
      // failure shouldn't erase data the user can already see.
    } finally {
      setLoading(false);
    }
  }, [key]);

  useEffect(() => {
    load();
  }, [load]);

  return { data, loading, isStale, error, refresh: load };
}
