import type { DatabaseSync } from 'node:sqlite';

/** Every venue the catalog has, by name. */
export const venueNames = (db: DatabaseSync): string[] =>
  (db.prepare('SELECT DISTINCT name FROM venue ORDER BY name').all() as { name: string }[]).map(one => one.name);
