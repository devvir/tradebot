import fs from 'node:fs';
import path from 'node:path';
import type { SourceFile } from './types';

/**
 * Every partition in the vault, with its attributes.
 *
 * **Read off the path, not the filename.** A filename carries the extras
 * positionally as bare values — `klines.htx.spot.AAVE-USDT.4h.202603.parquet`
 * says `4h` without saying it is an interval — while the path names them
 * (`dataset=klines/interval=4h/`). Since the walk has the path in hand anyway,
 * taking them from there costs nothing and keeps the parser free of rules about
 * which dataset has which extra.
 *
 * `followSymlinks` is on: a venue may be parked on another disk behind a
 * symlink, and a walk that silently skipped it would report the vault as
 * smaller than it is rather than failing.
 */
export const scanVault = async (root: string): Promise<SourceFile[]> => {
  const found: SourceFile[] = [];

  await walk(root, '', found);

  return found;
};

/**
 * The letter a symbol is filed under — the one path level that is not
 * `key=value`, and is skipped rather than parsed.
 *
 * It exists to bound how many directories a market holds; it says nothing about
 * the data, which is why nothing here reads it.
 */
export const isBucket = (segment: string): boolean => ! segment.includes('=');

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * Yielding to the event loop this often while walking.
 *
 * **A synchronous walk of 126,000 files cannot be interrupted.** Node cannot run
 * a signal handler until the call stack unwinds, so Ctrl-C during a scan is
 * silently held until the walk finishes — which on a cold cache is a long time
 * to sit watching a terminal ignore you. Handing control back periodically costs
 * a few hundred ticks over the whole walk and makes the process answer.
 */
const YIELD_EVERY = 500;

let since = 0;

const breathe = async (): Promise<void> => {
  if (++since < YIELD_EVERY) return;

  since = 0;

  await new Promise(resolve => setImmediate(resolve));
};

const walk = async (root: string, relative: string, found: SourceFile[]): Promise<void> => {
  const here = path.join(root, relative);

  await breathe();

  let entries: fs.Dirent[];

  try {
    entries = fs.readdirSync(here, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    // `@meta` holds the build ledger and the scratch directories hold work in
    // progress. Neither is a partition, and both sit at the vault root.
    if (entry.name.startsWith('@') || entry.name.startsWith('.')) continue;

    const next = relative ? `${relative}/${entry.name}` : entry.name;

    // `isDirectory` is false for a symlinked venue, so the type is resolved
    // rather than trusted.
    if (isDirectory(path.join(root, next))) {
      await walk(root, next, found);

      continue;
    }

    if (! entry.name.endsWith('.parquet')) continue;

    const parsed = describe(next);

    if (parsed) {
      const stat = fs.statSync(path.join(root, next));

      found.push({ ...parsed, bytes: stat.size, mtime: Math.floor(stat.mtimeMs) });
    }
  }
};

const isDirectory = (absolute: string): boolean => {
  try {
    return fs.statSync(absolute).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Pull a partition's identity out of its path.
 *
 * Returns null for anything that does not read as one, so a stray file cannot
 * enter the plan by being packed under a wrong name. Every level is checked by
 * its key rather than by position, because the letter bucket sits in the middle
 * and a venue may one day gain a level.
 */
const describe = (relative: string): Omit<SourceFile, 'bytes' | 'mtime'> | null => {
  const parts = relative.split('/');
  const file  = parts.pop();

  if (! file) return null;

  const attributes = new Map<string, string>();
  const extras:     string[] = [];

  for (const segment of parts) {
    if (isBucket(segment)) continue;

    const at    = segment.indexOf('=');
    const key   = segment.slice(0, at);
    const value = segment.slice(at + 1);

    if (KNOWN.includes(key)) attributes.set(key, value);
    else extras.push(segment);
  }

  const venue   = attributes.get('venue');
  const market  = attributes.get('market');
  const symbol  = attributes.get('symbol');
  const dataset = attributes.get('dataset');

  if (! venue || ! market || ! symbol || ! dataset) return null;

  // `klines.bitget.spot.ZROUSDT.1m.202411.parquet` — the month is the last
  // field before the extension, whatever the extras did to the ones before it.
  const fields = file.replace(/\.parquet$/, '').split('.');
  const month  = fields[fields.length - 1];

  if (! month || ! /^[0-9]{6}$/.test(month)) return null;

  return {
    path: relative,
    venue, market, symbol, dataset, month,
    variant: extras.length > 0 ? extras.join('/') : null,
  };
};

/** Levels that name the partition. Anything else `key=value` is an extra. */
const KNOWN = ['venue', 'market', 'symbol', 'dataset'];

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_describe = describe;
