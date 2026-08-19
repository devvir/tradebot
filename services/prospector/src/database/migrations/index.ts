import { core } from './001-core';
import { htxRetirements } from './002-htx';
import { okxSeries } from './003-okx';
import { bitgetSeries } from './004-bitget';
import type { Migration } from '../../types';

/**
 * Schema and shipped data, applied in order and exactly once.
 *
 * Versioning uses SQLite's own `user_version` — an integer in the database
 * header that nothing else touches — so a database that has never heard of
 * migrations reports 0 and needs no special case.
 *
 * **Every database runs every migration, from zero.** A fresh catalog is not
 * jumped to the head shape and stamped as done: that made the chain run on some
 * databases and not others, which is not a migration system, and it left nowhere
 * to put anything a new deployment needs.
 *
 * So `MIGRATIONS[i]` takes the schema **from version i to version i+1**, the
 * array index is the version it upgrades from, and the list is append-only.
 * Editing one that has shipped changes nothing on a database that already ran it
 * and silently diverges the two.
 *
 * Each runs in its own transaction together with its version bump, so a failure
 * leaves the database at the version it was, never half-migrated.
 *
 * **Three, and each is a thing rather than a step.** The catalog's shape with
 * the rows that are constants of it, then the two venues whose contents cannot
 * be discovered and therefore ship measured. There is no history here because
 * there is nothing to replay: a chain of deltas is worth keeping only while
 * databases exist at the versions between them, and none do.
 */
export const MIGRATIONS: readonly Migration[] = [
  core,
  htxRetirements,
  okxSeries,
  bitgetSeries,
];

/** The version a database that has run every migration reports. */
export const SCHEMA_VERSION = MIGRATIONS.length;
