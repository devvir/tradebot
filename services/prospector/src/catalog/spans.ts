import type { DatabaseSync } from 'node:sqlite';
import * as wip from './wip';
import { byteOrder, ceiling } from '../paths';
import { statement } from './state';
import { ROW, stateOf } from './rows';
import type { FileRow as Row, PathRow } from '../types';
import type { DirectorySpan, Edge, FileEffect, RangeSpan, Span, Withdrawal } from '../types';

/**
 * What a walked page's span says the venue no longer offers.
 *
 * **A walked page states a span exhaustively** — see `Span` — so a file
 * catalogued inside it that the page did not list has been withdrawn, and a key
 * parked inside it that the page did not list is no longer worth asking about.
 * These find both, mark the first and unpark the second, inside the caller's
 * transaction.
 */

export const isRange = (span: Span): span is RangeSpan => 'low' in span;

/** Whether a path sorts before an upper edge. */
export const below = (path: string, upto: Edge): boolean => {
  const order = byteOrder(path, upto.path);

  return order < 0 || (order === 0 && ! upto.open);
};

/** Whether a path falls inside the span, so the span's read answers for it. */
export const inSpan = (path: string, span: RangeSpan): boolean => {
  const order = byteOrder(path, span.low);

  return (order > 0 || (order === 0 && ! span.lowOpen)) && below(path, { path: span.high, open: span.highOpen });
};

/** The catalogued files between two edges, in order, each with its path. */
export const rowsIn = (db: DatabaseSync, venueId: number, from: Edge, to: Edge): PathRow[] =>
  statement(db,
    `SELECT path, ${ROW} FROM file
      WHERE venue_id = ? AND path ${from.open ? '>' : '>='} ? AND path ${to.open ? '<' : '<='} ?
      ORDER BY path`,
  ).all(venueId, from.path, to.path) as unknown as PathRow[];

/**
 * Mark these files withdrawn, and say what that did to their partitions. Returns how
 * many were.
 *
 * **Only `existence` changes.** A withdrawn file keeps its row, its history and
 * its `seen_at`, so the catalog stays a record of everything ever published,
 * and a consumer that wants only live files says so.
 */
export const withdraw = (
  db:      DatabaseSync,
  venueId: number,
  gone:    readonly { path: string; row: Row }[],
  effects: FileEffect[],
  notes:   Withdrawal[],
): number => {
  const mark = statement(db, `UPDATE file SET existence = 'absent' WHERE venue_id = ? AND path = ?`);

  for (const { path, row } of gone) {
    mark.run(venueId, path);

    notes.push({
      event: 'withdrawn', cause: 'walk', venueId, path, date: row.date,
      size: row.size, etag: row.etag, downloaded: row.downloadedAt !== null,
    });

    effects.push({
      was: stateOf(row.partitionId, row.existence, row.size, row.etag, row.downloadedAt),
      now: stateOf(row.partitionId, 'absent',      row.size, row.etag, row.downloadedAt),
    });
  }

  return gone.length;
};

/**
 * **A withdrawal reaches the backlog too.** A file the venue dropped before
 * anyone probed it was never catalogued, so there is nothing to keep a record of
 * and nothing counted to correct — but left parked, the probe would ask a venue
 * about a key it no longer serves, for ever. Returns the change to the backlog's
 * count, which is never positive.
 *
 * `direct` keeps to the paths directly inside the lower edge, a directory —
 * what a directory index states, and nothing below it.
 */
export const dropParked = (
  db:      DatabaseSync,
  backlog: ReturnType<typeof wip.writer>,
  venueId: number,
  from:    Edge,
  to:      Edge,
  offered: ReadonlySet<string>,
  direct = false,
): number => {
  let delta = 0;

  for (const path of wip.pathsIn(db, venueId, from, to)) {
    if (offered.has(path)) continue;

    if (direct && path.slice(from.path.length).includes('/')) continue;

    delta += backlog.unpark(venueId, path);
  }

  return delta;
};

/**
 * What a directory index no longer offers: its own files the page did not list,
 * and the subdirectories it no longer links — each of which takes everything
 * catalogued below it.
 *
 * **Walked by seeking, not by reading the subtree.** A directory near the root
 * holds every file below it, and only its own files and its children's names
 * are wanted — so each step reads one row and jumps past a whole child at once.
 */
export const vacated = (
  db:      DatabaseSync,
  span:    DirectorySpan,
  offered: ReadonlySet<string>,
): { gone: { path: string; row: Row }[]; subtrees: string[] } => {
  const after = statement(db,
    `SELECT path, ${ROW} FROM file WHERE venue_id = ? AND path > ? AND path < ? ORDER BY path LIMIT 1`);
  const from  = statement(db,
    `SELECT path, ${ROW} FROM file WHERE venue_id = ? AND path >= ? AND path < ? ORDER BY path LIMIT 1`);

  const linked   = new Set(span.children);
  const end      = ceiling(span.directory);
  const gone:     { path: string; row: Row }[] = [];
  const subtrees: string[] = [];

  let next = after.get(span.venueId, span.directory, end) as (Row & { path: string }) | undefined;

  while (next) {
    const { path, ...row } = next;
    const rest  = path.slice(span.directory.length);
    const slash = rest.indexOf('/');

    if (slash < 0) {
      if (row.existence !== 'absent' && ! offered.has(path)) gone.push({ path, row });

      next = after.get(span.venueId, path, end) as unknown as typeof next;

      continue;
    }

    const child = span.directory + rest.slice(0, slash + 1);

    if (! linked.has(child)) subtrees.push(child);

    next = from.get(span.venueId, ceiling(child), end) as unknown as typeof next;
  }

  return { gone, subtrees };
};
