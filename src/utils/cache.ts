import { Directory, File, Paths } from 'expo-file-system';

// Deliberately NOT using storageHelpers/SecureStore here — SecureStore is
// capped at ~2KB per item (see src/lib/mmkv.ts's setObject, which silently
// skips saving anything larger) and is meant for small secrets like PINs,
// not general app data. A transaction list or service catalog can easily
// exceed that, so this uses a plain JSON file instead.
const CACHE_DIR = new Directory(Paths.document, 'kp_cache');

function ensureCacheDir(): void {
  try {
    if (!CACHE_DIR.exists) CACHE_DIR.create({ intermediates: true, idempotent: true } as any);
  } catch {
    // Best-effort — a cache directory failure shouldn't break the feature
    // that's using it, only the caching optimization on top of it.
  }
}

function cacheFile(key: string): File {
  const safeName = key.replace(/[^a-zA-Z0-9_-]/g, '_');
  return new File(CACHE_DIR, `${safeName}.json`);
}

export interface CacheEntry<T> {
  data: T;
  savedAt: number;
}

/** Reads a previously cached value, or null if none exists / it's corrupt. */
export function readCache<T>(key: string): CacheEntry<T> | null {
  try {
    const file = cacheFile(key);
    if (!file.exists) return null;
    return JSON.parse(file.textSync());
  } catch {
    return null;
  }
}

/** Best-effort write — never throws, since caching is an optimization, not the feature itself. */
export function writeCache<T>(key: string, data: T): void {
  try {
    ensureCacheDir();
    const file = cacheFile(key);
    if (!file.exists) file.create({ idempotent: true } as any);
    file.write(JSON.stringify({ data, savedAt: Date.now() } as CacheEntry<T>));
  } catch {
    // Ignored — see above.
  }
}
