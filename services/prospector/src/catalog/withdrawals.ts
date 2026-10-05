import { appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { logger } from '@devvir/service-kit';
import type { DatabaseSync } from 'node:sqlite';
import type { Withdrawal } from '../types';

/**
 * The record of every file that left the catalog and every one that came back,
 * kept as a file beside the database.
 *
 * **A withdrawal is rare and never ordinary.** An archive is insert-only unless
 * somebody erred, so a file the venue stops serving means one of two things:
 * the venue corrected a mistake, or it is making one now. The catalog itself
 * only keeps the outcome — a row marked absent — and says nothing of when it
 * happened, on whose word, or whether the same file had gone and returned
 * before. This says all three, in a place that is read without a query.
 *
 * **One line a file, as JSON**, so it can be counted and grouped as easily as
 * read. `returned` is written when a withdrawn file is catalogued again, which
 * is what tells a venue that withdrew a file from one that hid it for a while.
 *
 * It is a log and not state: nothing reads it back, and losing it loses
 * nothing the catalog depends on.
 */

/** The log's name, in the directory the database is in. */
export const WITHDRAWALS_LOG = 'withdrawals.log';

/**
 * Write these down, and say so once in the service's own log.
 *
 * Never throws: a log that cannot be written must not undo the write it
 * describes.
 */
export const noteWithdrawals = (db: DatabaseSync, entries: readonly Withdrawal[]): void => {
  if (entries.length === 0) return;

  const file  = logOf(db);
  const at    = new Date().toISOString();
  const venue = new Map<number, { venue: string; host: string }>();

  for (const { venueId } of entries)
    if (! venue.has(venueId)) venue.set(venueId, venueOf(db, venueId));

  const named = entries.map(one => ({ at, ...venue.get(one.venueId)!, ...one }));

  for (const event of ['withdrawn', 'returned'] as const) {
    const these = named.filter(one => one.event === event);

    if (these.length === 0) continue;

    logger.warn({
      venue: these[0]!.venue, cause: these[0]!.cause, files: these.length,
      first: these[0]!.path, ...(file ? { log: file } : {}),
    }, event === 'withdrawn' ? 'Files withdrawn from the catalog' : 'Withdrawn files are back in the catalog');
  }

  if (! file) return;

  try {
    appendFileSync(file, named.map(({ venueId: _venueId, ...line }) => JSON.stringify(line) + '\n').join(''));
  } catch (err) {
    logger.error({ file, error: (err as Error).message }, 'Could not write the withdrawals log');
  }
};

// ── Internals ─────────────────────────────────────────────────────────────────

/** Where this database's log is; null for a database that is not a file. */
const logOf = (db: DatabaseSync): string | null => {
  if (! LOGS.has(db)) {
    const main = (db.prepare('PRAGMA database_list').all() as { name: string; file: string }[])
      .find(one => one.name === 'main');

    LOGS.set(db, main?.file ? join(dirname(main.file), WITHDRAWALS_LOG) : null);
  }

  return LOGS.get(db)!;
};

const venueOf = (db: DatabaseSync, venueId: number): { venue: string; host: string } => {
  const row = db.prepare('SELECT name, host FROM venue WHERE id = ?')
    .get(venueId) as { name: string; host: string } | undefined;

  return { venue: row?.name ?? `#${venueId}`, host: row?.host ?? '' };
};

const LOGS = new WeakMap<DatabaseSync, string | null>();
