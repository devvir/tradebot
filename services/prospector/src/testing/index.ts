import type { DatabaseSync } from 'node:sqlite';
import { openCatalog } from '../database/open';

/**
 * The catalog's schema, for building catalogs in tests, served as the
 * `@tradebot/prospector/testing` subpath.
 *
 * Everything here is the schema the service itself creates, not a copy of it, so
 * a database built from it has the tables, types, indexes and triggers a real
 * catalog has.
 */

export { AT_CREATION, CATALOG_SCHEMA, ON_OPEN } from '../database/schema';
export { SCHEMA_VERSION } from '../database/migrations';

/**
 * An empty catalog: the whole schema at `SCHEMA_VERSION`, holding no rows — not
 * even the venues and exclusions a catalog ships with — and opened with the
 * pragmas every catalog is opened with, foreign keys on.
 *
 * In memory where no path is given; otherwise created at `path`, which is a file
 * that does not exist yet. A path that already holds a catalog is opened as the
 * service opens it, rows and all.
 */
export const emptyCatalog = (path = ':memory:'): DatabaseSync =>
  openCatalog(path, { seedData: false });
