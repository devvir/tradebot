import { core } from './001-core';
import { htxRetirements } from './002-htx';
import { okxSeries } from './003-okx';
import { bitgetSeries } from './004-bitget';
import { carts } from './005-carts';
import { gateMisfiled } from './006-gate';
import { lenses } from './007-lens';
import { binanceRetirements } from './008-binance';
import { pendingIndex } from './009-pending';
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
 * **Each is a thing rather than a step.** The catalog's shape with the rows that
 * are constants of it, then the venues whose contents cannot be discovered and
 * therefore ship measured, then the tables carts live in — which arrived after
 * the baseline and are in it too, so a fresh catalog gets them from the shape
 * and a catalog in service gets them from the migration — and last the shapes a
 * venue used once and abandoned, which no amount of reading can date.
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
  carts,
  gateMisfiled,
  lenses,
  binanceRetirements,
  pendingIndex,
];

/** The version a database that has run every migration reports. */
export const SCHEMA_VERSION = MIGRATIONS.length;
