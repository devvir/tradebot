import { core } from './001-core';
import { htxRetirements } from './002-htx';
import { okxSeries } from './003-okx';
import { bitgetSeries } from './004-bitget';
import { gateMisfiled } from './005-gate';
import { binanceRetirements } from './006-binance';
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
 * So `MIGRATIONS[i]` takes the schema **from version i to version i+1**, and the
 * array index is the version it upgrades from.
 *
 * **The chain is the catalog as it is, not a history of how it got there.** No
 * catalog is shared or deployed yet, so a change edits the migration it belongs
 * to rather than adding one on top — and the one live catalog is brought to
 * match by running the same statements by hand, `user_version` included. That
 * holds until the project has a second developer or a production deployment;
 * from then on a migration that has shipped is frozen and the list only grows.
 *
 * Each runs in its own transaction together with its version bump, so a failure
 * leaves the database at the version it was, never half-migrated.
 *
 * **Each is a thing rather than a step.** The catalog's shape with the rows that
 * are constants of it, then the venues whose contents cannot be discovered and
 * therefore ship measured, and last the shapes a venue used once or stopped
 * writing, which no amount of reading can date.
 *
 * There is otherwise no history here, because there is nothing to replay: a
 * chain of deltas is worth keeping only while databases exist at the versions
 * between them.
 */
export const MIGRATIONS: readonly Migration[] = [
  core,
  htxRetirements,
  okxSeries,
  bitgetSeries,
  gateMisfiled,
  binanceRetirements,
];

/** The version a database that has run every migration reports. */
export const SCHEMA_VERSION = MIGRATIONS.length;
