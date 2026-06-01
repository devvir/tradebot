/**
 * Type-safe wrapper around `localStorage`. Handles JSON serialization so
 * callers never touch strings — they read and write typed values directly.
 * Operations swallow exceptions: localStorage may be disabled (private mode),
 * full (quota), or unavailable (SSR). A missing or corrupt value yields the
 * caller's fallback.
 */

export function get<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);

    if (raw === null) return fallback;

    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function set<T>(key: string, value: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /** disabled / quota / SSR — silent */
  }
}

export function remove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /** see `set` */
  }
}
