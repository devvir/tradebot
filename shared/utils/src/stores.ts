/**
 * Fetch key from map if present, otherwise set default value and return it.
 */
export function mapGet<T>(map: Map<any, T>, key: any, defaultValue: T | (() => T)): T;
export function mapGet<T>(map: Map<any, T>, key: any): T | undefined;
export function mapGet<T>(map: Map<any, T>, key: any, defaultValue?: T | (() => T)): T | undefined {
  if (defaultValue === undefined || map.has(key)) return map.get(key);

  const value = typeof defaultValue === 'function' ? (defaultValue as () => T)() : defaultValue;

  map.set(key, value);

  return value as T;
}