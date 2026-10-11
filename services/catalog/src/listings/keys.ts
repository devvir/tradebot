import { logger } from '@devvir/service-kit';
import { extensionOf } from './shape';
import type { DatabaseSync } from 'node:sqlite';
import type { Keyed, KeyedFile, Lens } from '../types';

/**
 * A file's key: what the file *is*, and where it sits in the listing.
 *
 * ```
 * venue/market/dataset[,variant]/F/symbol/YYYYMM/venue|market|dataset[,variant]|symbol|date[.partNN].ext
 * venue/market/dataset[,variant]/@/YYYYMM/venue|market|dataset[,variant]|@|date[.partNN].ext
 * binance/perp/klines,1m/B/BTCUSDT/202001/binance|perp|klines,1m|BTCUSDT|20200101.zip
 * ```
 *
 * The prefix is the series' own (`series.prefix`, written by prospector); the
 * month is the date's; the name repeats every part of the prefix but the letter,
 * so a name read alone says everything. **The venue-wide file, `@`, has no
 * letter folder**, so its keys are one segment shorter — see `depthOf`. A part sits before the extension, where
 * a downloaded file's name would carry it.
 *
 * **Keys sort as the listing reads**: by prefix, then by date, then by part — a
 * month's file before its days, since `.` sorts below every digit.
 */
export const keyOf = (prefix: string, pattern: string, file: { date: string; path: string }): string => {
  const [venue, market, dataset, letter, named] = prefix.split('/');
  const symbol = letter === BUCKET ? BUCKET : named;
  const part = partOf(file.path, pattern);

  return `${prefix}${file.date.slice(0, 6)}/${venue}|${market}|${dataset}|${symbol}|${file.date}`
    + `${part === undefined ? '' : `.part${part}`}${extensionOf(file.path)}`;
};

/**
 * The file each key names, or why there is none: `NoSuchKey` where it names no
 * file, `AccessDenied` where the lens a request reads through does not let it
 * through.
 *
 * **Found by building, not by parsing.** A key's prefix and date narrow it to a
 * series' files of one day — one file, or a day's parts — and each is given its
 * key the way the listing gives it; the one that matches is the file. Nothing
 * here has to understand a filename, so nothing here can misread one.
 *
 * **Each series' day is read and keyed once, however many of its keys are
 * asked.** A day can hold tens of thousands of parts — a month of minutes, as
 * one file each — and keying them all again for every key asked is minutes on
 * the one thread every request waits for.
 */
export const filesOfKeys = (db: DatabaseSync, keys: readonly string[], lens: Lens | null): Map<string, Keyed> => {
  const found = new Map<string, Keyed>();
  const days  = new Map<string, { prefix: string; date: string; keys: string[] }>();

  for (const key of keys) {
    const parts = key.split('/');
    const depth = depthOf(parts);
    const date  = parts.length === depth + 2 ? parts[depth + 1]!.split('|')[4]?.split('.')[0] : undefined;

    if (! date) {
      found.set(key, 'NoSuchKey');
      continue;
    }

    const prefix = `${parts.slice(0, depth).join('/')}/`;
    const day    = days.get(`${prefix}|${date}`) ?? { prefix, date, keys: [] };

    day.keys.push(key);
    days.set(`${prefix}|${date}`, day);
  }

  const files = db.prepare(
    `SELECT f.rowid AS id, f.series_id AS seriesId, f.date, f.path, p.pattern
       FROM series s
       JOIN pattern p ON p.id = s.pattern_id
       JOIN file f    ON f.series_id = s.id
      WHERE s.prefix = ? AND f.date = ? AND f.existence = 'confirmed'`,
  );

  // The file's partition: its series' slice, at the month of its date.
  const through = db.prepare(
    `SELECT 1 FROM series s
       JOIN pattern p     ON p.id = s.pattern_id
       JOIN partition q   ON q.slice_id = p.slice_id AND q.month = ?
       JOIN lens_member l ON l.lens_id = ? AND l.partition_id = q.id
      WHERE s.id = ?`,
  );

  const allowed = new Map<string, boolean>();

  for (const { prefix, date, keys: asked } of days.values()) {
    const keyed = new Map<string, KeyedFile[]>();

    for (const one of files.all(prefix, date) as unknown as (KeyedFile & { pattern: string })[]) {
      const key = keyOf(prefix, one.pattern, one);

      keyed.set(key, [...keyed.get(key) ?? [], { id: one.id, seriesId: one.seriesId, date: one.date, path: one.path }]);
    }

    for (const key of asked) {
      const same = keyed.get(key) ?? [];

      if (same.length === 0) {
        found.set(key, 'NoSuchKey');
        continue;
      }

      if (same.length > 1)
        logger.error({ key, paths: same.map(one => one.path) }, 'Two catalogued files share one key — settling the first');

      const file  = same[0]!;
      const month = `${file.seriesId}|${file.date.slice(0, 6)}`;

      if (lens && ! allowed.has(month)) allowed.set(month, Boolean(through.get(file.date.slice(0, 6), lens.id!, file.seriesId)));

      found.set(key, lens && ! allowed.get(month) ? 'AccessDenied' : file);
    }
  }

  return found;
};

/**
 * How many segments of a key are its series prefix: five —
 * `venue/market/dataset/F/symbol` — or four where the fourth is `@`, the
 * venue-wide file, which has no letter folder. `@` is never anything else, so
 * the key alone says which.
 */
export const depthOf = (parts: readonly string[]): number => (parts[3] === BUCKET ? 4 : 5);

// ── Internals ─────────────────────────────────────────────────────────────────

/** The venue-wide file's symbol, and its folder. */
const BUCKET = '@';

/**
 * Which of a period's files this one is, where the pattern splits a period:
 * what the path holds where the pattern says `{PART}` — an hour of gate's books,
 * a numbered piece of a bitget day.
 *
 * Read off the name alone, the pattern's last segment matched against the
 * path's: the other placeholders match what they can hold, and everything else
 * must be literally there.
 */
const partOf = (path: string, pattern: string): string | undefined => {
  if (! pattern.includes('{PART}')) return undefined;

  return path.slice(path.lastIndexOf('/') + 1).match(nameOf(pattern))?.groups?.['part'];
};

/** A pattern's last segment as a regular expression, held per pattern. */
const nameOf = (pattern: string): RegExp => {
  let held = NAMES.get(pattern);

  if (! held) {
    const name   = pattern.slice(pattern.lastIndexOf('/') + 1);
    const source = name
      .split(/(\{TRANSFORM:[^{}]*(?:\{[A-Z_]+\})?[^{}]*\}|\{[A-Z_]+\})/)
      .map((piece, at) => (at % 2 === 1 ? TOKENS[piece] ?? '.+?' : piece.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      .join('');

    held = new RegExp(`^${source}$`);
    NAMES.set(pattern, held);
  }

  return held;
};

/** What each placeholder matches inside a name. */
const TOKENS: Record<string, string> = {
  '{YYYY}':           '\\d{4}',
  '{MM}':             '\\d{2}',
  '{DD}':             '\\d{2}',
  '{MONTH_LAST_DAY}': '\\d{2}',
  '{SYMBOL}':         '.+?',
  '{PART}':           '(?<part>.+?)',
};

const NAMES = new Map<string, RegExp>();

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_partOf = partOf;
