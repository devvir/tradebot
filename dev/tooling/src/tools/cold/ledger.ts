import fs from 'node:fs';
import path from 'node:path';
import type { PartitionKey } from './types';

/**
 * Stocker's record of what it built, as cold storage reads it.
 *
 * **The one thing cold storage cannot answer for itself.** It knows which files
 * it packed and which raw they came from; it does not know what stocker *set
 * out* to build, because that is a record of what stocker did rather than of
 * what was backed up. Two commands need it and need different readings of it,
 * so the parsing lives here rather than twice:
 *
 * - `cold evict archives` asks which partitions a raw file fed, to know whether
 *   deleting that raw would strand something unmodelled.
 * - `cold push vault` asks which partitions a month should contain, to know
 *   whether packing it now would record a fragment as a finished month.
 *
 * It is the same kind of dependency `cold push archives` already has on the
 * collector's published tips — a documented output, not a reach into internals —
 * and it is confined to this file, since the ledger is expected to stop being
 * flat files.
 *
 * **Only `<dataset>.<venue>.jsonl` is read.** Anything else in the directory is
 * not a ledger, whatever it looks like: a `klines.bitget.jsonl.bak` left behind
 * by a repair described 4,480 partitions under a layout that no longer exists,
 * and reading it would have blocked twenty bitget months against records nothing
 * could ever satisfy.
 */

/** `klines|bitget|spot|BTCUSDT|1m|2020-08` — stocker's id for one partition. */
export const idOf = (key: PartitionKey): string => {
  const extras = key.variant
    ? key.variant.split('/').map(level => level.slice(level.indexOf('=') + 1))
    : [];

  return [key.dataset, key.venue, key.market, key.symbol, ...extras,
    `${key.month.slice(0, 4)}-${key.month.slice(4)}`].filter(Boolean).join('|');
};

/**
 * Which partitions each raw file of a venue fed.
 *
 * Ledger paths are relative to the venue root and cold's are venue-prefixed, so
 * the venue — which the filename carries — is put back on.
 */
export const inputsByRaw = async (
  vaultRoot: string,
  venue:     string,
): Promise<Map<string, string[]>> => {
  const found   = new Map<string, string[]>();
  const current = new Map<string, { path: string }[]>();

  let seen = 0;

  for (const file of filesFor(vaultRoot, venue))
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (! line) continue;

      try {
        const entry = JSON.parse(line) as { id: string; inputs?: { path: string }[] };

        current.set(entry.id, entry.inputs ?? []);
      } catch {
        // A torn final line is the ordinary shape of an append-only file being
        // written to. The partitions it describes simply read as not yet built.
      }

      if (++seen % BREATH === 0) await breathe();
    }

  for (const [id, inputs] of current)
    for (const input of inputs) {
      const key = `${venue}/${input.path}`;
      const ids = found.get(key) ?? [];

      if (! ids.includes(id)) ids.push(id);

      found.set(key, ids);
    }

  return found;
};

/**
 * Which partitions a venue's months should contain, keyed `YYYYMM`.
 *
 * **The id is taken with a regex rather than by parsing the line.** Only the id
 * is wanted here and `inputs` is the whole weight of the file — 336MB across the
 * ledger — so reading the rest costs seconds per run to produce nothing. The
 * month is the id's last segment, which is what makes that affordable.
 *
 * Duplicate ids collapse into the set on their own, which is the right reading:
 * the file is append-only and a rebuild appends, so a partition written five
 * times is still one partition the month should hold.
 */
export const idsByMonth = async (
  vaultRoot: string,
  venue:     string,
): Promise<Map<string, Set<string>>> => {
  const found = new Map<string, Set<string>>();

  let seen = 0;

  for (const file of filesFor(vaultRoot, venue))
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const matched = /^\{"id":"([^"]+)"/.exec(line);

      if (matched) {
        const id    = matched[1]!;
        const month = id.slice(id.lastIndexOf('|') + 1).replace('-', '');
        const ids   = found.get(month) ?? new Set<string>();

        ids.add(id);
        found.set(month, ids);
      }

      if (++seen % BREATH === 0) await breathe();
    }

  return found;
};

// ── Internals ─────────────────────────────────────────────────────────────────

/** A venue's ledger files, and nothing else that happens to sit beside them. */
const filesFor = (vaultRoot: string, venue: string): string[] => {
  const dir = path.join(vaultRoot, '@meta', 'built');

  try {
    return fs.readdirSync(dir)
      .filter(name => name.endsWith(`.${venue}.jsonl`))
      .map(name => path.join(dir, name));
  } catch {
    return [];
  }
};

/**
 * Hand the event loop back for one tick.
 *
 * **This is what makes Ctrl-C work.** Node delivers a signal through the event
 * loop, so a handler cannot run while a synchronous run holds the stack — and
 * the ledger is hundreds of megabytes with no natural await in reading it. The
 * signal is not lost, it is queued behind work that has to finish first, which
 * reads exactly like a command ignoring it.
 */
const BREATH = 2_000;

const breathe = (): Promise<void> => new Promise(resolve => { setImmediate(resolve); });

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_filesFor = filesFor;
