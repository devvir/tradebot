import fs from 'node:fs';
import path from 'node:path';
import { info } from '../../../shared/ui/logger';
import * as db from '../db';
import type { DatabaseSync } from 'node:sqlite';
import type { ColdConfig, PendingGroup, PendingPlan, Planner, SourceFile } from '../types';

/**
 * The raw venue archives, exactly as the venues published them.
 *
 * **Two gates in front of the same file comparison the vault uses.**
 *
 * The first is the producer's: a venue-month is a candidate only once the
 * collector has published it as collected through. Not because a later file
 * could not be handled — the record is at file grain and a month can be
 * appended to — but because packing an open month produces a stream of tiny
 * parts, one per collection pass, for ever.
 *
 * The second is arithmetic. The vault rebuilds its whole path map every run at
 * 190,000 partitions; the archives hold 4.9 million files and are expected to
 * grow by tens of terabytes. A month whose closing has not changed since it was
 * planned is skipped without being walked at all, so the cost of a run tracks
 * what actually changed rather than what exists.
 *
 * Beyond those, this knows nothing about any venue. Seven venues use seven tree
 * shapes; a file's month is read off its path, and a path whose date cannot be
 * read stops the run rather than being skipped — every archive file has one, so
 * a path without one is a bug in collection or in this detection.
 */
export const archives: Planner = {
  async pending(
    handle: DatabaseSync,
    config: ColdConfig,
    venues: string[],
  ): Promise<PendingPlan> {
    const tips     = readTips(config.sharedRoot);
    const closings = readClosings(config.sharedRoot);
    const gates    = db.closings(handle, 'archives');

    if (tips.size === 0) {
      info(`No venue has published a collected-through month in ${config.sharedRoot}/complete`);

      return { groups: [], withheld: 0 };
    }

    const groups: PendingGroup[] = [];

    let walked  = 0;
    let entries = 0;
    let skipped = 0;

    /**
     * **Every file in the archive carries a date somewhere in its path.**
     *
     * Venues vary wildly in where they put it — a directory, a filename, often
     * both — but none omits it, because a date is what a historical archive is
     * indexed by. So a path this cannot read is not a curiosity to note and
     * move past; it is one of two bugs. Either trucker collected something it
     * should not have, or this detection is too narrow.
     *
     * Which is why it stops the run rather than warning. The failure mode is
     * silent by construction: unmatched files are simply never packed, the run
     * reports success, and nothing ever contradicts it. 16,362 bitget files sat
     * unbacked behind the line `carry no date in their path and were left
     * alone` — accurate, unmissable in hindsight, and completely ignorable in a
     * block of scan output.
     */
    const undated: string[] = [];

    for (const [venue, tip] of [...tips].sort()) {
      /**
       * Skipped before the walk, not after it. A venue nobody asked about is
       * millions of `readdir` entries for a result that is then discarded, and
       * it is the slowest thing this command does.
       */
      if (venues.length > 0 && ! venues.includes(venue)) continue;

      info(`Scanning ${venue} through ${tip} …`);

      /**
       * Paths first, sizes second. Most of an archive is newer than its tip, so
       * sizing every file up front means millions of `stat` calls for files
       * that are then discarded — the walk yields names, and only the survivors
       * are measured.
       */
      const byMonth = new Map<string, string[]>();

      for (const relative of walk(config.sourceRoot, venue, tip)) {
        /**
         * **This is what makes Ctrl-C work.** Node delivers a signal through
         * the event loop, so a handler cannot run while a synchronous stretch
         * holds the stack — and a venue is millions of `readdir` entries with
         * no natural await anywhere in it. The signal is not lost, it is queued
         * behind work that has to finish first, which reads exactly like a
         * command ignoring you: four venues scrolled past a `^C^C^C` and kept
         * going.
         *
         * Yielding by count rather than by clock because the loop is uniform,
         * and a tick every few thousand entries is far below measurable against
         * the directory reads it sits between.
         */
        if (++entries % BREATH === 0) await breathe();

        const month = monthOf(relative);

        if (! month) {
          undated.push(relative);

          continue;
        }

        if (month > tip) continue;

        // The gate: a month whose closing has not moved since it was planned
        // needs no comparison, and this is the only place that is decided.
        if (gates.get(`${venue}/${month}`) === closedAt(closings, venue, month)) {
          skipped++;

          continue;
        }

        const list = byMonth.get(month) ?? [];

        list.push(relative);
        byMonth.set(month, list);
      }

      for (const [month, paths] of [...byMonth].sort()) {
        const known = db.packedIn(handle, 'archives', venue, month);
        const files: SourceFile[] = [];

        for (const relative of paths) {
          const stat = statOf(path.join(config.sourceRoot, relative));

          if (! stat) continue;

          const seen  = known.get(relative);
          const bytes = stat.size;
          const mtime = Math.floor(stat.mtimeMs);

          if (seen && seen.bytes === bytes && seen.mtime === mtime) continue;

          files.push({
            path: relative, bytes, mtime, venue, month,
            market: null, symbol: null, dataset: null, variant: null,
          });
        }

        walked++;

        /**
         * A month that was walked and turned out to hold nothing new still gets
         * its gate written, so the next run skips it. Returning it as an empty
         * group is what carries that — the alternative is walking a settled
         * month for ever to reach the same answer.
         */
        groups.push({ venue, month, closedAt: closedAt(closings, venue, month), files });
      }
    }

    /**
     * Checked after every venue rather than at the first offender, so the
     * examples span the tree and one report shows whether this is one venue's
     * shape or something broader.
     */
    if (undated.length > 0) throw new Error(undatedReport(undated));

    const pending = groups.filter(group => group.files.length > 0);
    const bytes   = pending.reduce((total, group) =>
      total + group.files.reduce((sum, file) => sum + file.bytes, 0), 0);

    info(`${walked} month${walked === 1 ? '' : 's'} examined · `
      + `${skipped.toLocaleString()} files skipped in months already settled · `
      + `${pending.length} month${pending.length === 1 ? '' : 's'} to plan · `
      + `${(bytes / 1024 ** 3).toFixed(1)}GB`);

    /**
     * Nothing is withheld here. A month past the collector's tip is not a
     * candidate turned away — it is one that has not arrived yet, and saying so
     * at the end of a run would report ordinary progress as something refused.
     */
    return { groups, withheld: 0 };
  },

  /**
   * Filled to the cap in path order, and nothing is held together.
   *
   * **There is no atom here.** The vault keeps a symbol whole because a restore
   * asks for one; an archive restore asks for a venue-month, and the seven tree
   * shapes offer no level that reliably names a symbol anyway. Encoding each
   * venue's hierarchy to protect a boundary nobody restores at would be a
   * per-venue rule in a place that has managed to avoid every other one.
   *
   * Path order still buys something for free: a part covers a contiguous range,
   * so related files stay together whatever hierarchy a venue happens to use.
   *
   * A file larger than the cap gets a part to itself rather than being split —
   * a tar that restores on its own is worth more than an exact size bound.
   */
  pack(files: SourceFile[], capBytes: number): SourceFile[][] {
    const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const parts: SourceFile[][] = [];

    let current: SourceFile[] = [];
    let bytes = 0;

    for (const file of sorted) {
      if (bytes > 0 && bytes + file.bytes > capBytes) {
        parts.push(current);

        current = [];
        bytes   = 0;
      }

      current.push(file);
      bytes += file.bytes;
    }

    if (current.length > 0) parts.push(current);

    return parts;
  },
};

/**
 * The month a file belongs to, read off its path.
 *
 * Four forms cover every venue seen, and they are matched rather than declared —
 * no venue is ever named here.
 */
export const monthOf = (relative: string): string | null => {
  /**
   * Dashed first, and deliberately not merged into one alternation with the
   * undashed forms. A single regex matches at the earliest position rather than
   * by preference, and Bybit lists symbols like `10000000AIDOGEUSDT` — eight
   * digits sitting ahead of the real date in the path, which would win on
   * position while being nothing of the kind.
   */
  const dashed = DASHED.exec(relative);

  if (dashed) return `${dashed[1]}${dashed[2]}`;

  const plain = PLAIN.exec(relative);

  // Group 2 is the separator; the month is group 3.
  if (plain) return `${plain[1]}${plain[3]}`;

  return null;
};

// ── Internals ─────────────────────────────────────────────────────────────────

/** `2026-07-24` and `2026-07`, anywhere in the path. */
const DASHED = /(20\d{2})-(\d{2})(?:-\d{2})?/;

/**
 * `202607`, `20260724`, `2026_07_24`, `2026.07.24` — the date wherever it sits,
 * bounded by non-digits.
 *
 * **The boundary is a digit boundary, not a path separator.** Requiring a
 * leading `/` covers `/202607/` and `/20260724…` but misses the date inside a
 * filename, which is where bitget puts it: `XRPUSDT_SPBL_20190506_001.zip`,
 * `ETHUSDT_SP_1min_20180725.zip`. That was 16,362 files across 15 whole
 * venue-months reading as undated and never packed — a plain `YYYYMMDD` in a
 * filename being about as ordinary as a date shape gets.
 *
 * Three things keep the broad rule from over-matching. The lookbehind stops a
 * match part-way through a run of digits, so bybit's `10000000AIDOGEUSDT` still
 * yields nothing. The separator backreference forces one style throughout, so
 * `2026-0724` is not a date. And the month is `01`–`12` and the day `01`–`31`,
 * so a serial like `202599` is rejected on its face.
 *
 * Verified across all 4.96 million files of all seven venues: no path resolves
 * differently, none is lost, and none is left undated.
 */
const PLAIN = /(?<![0-9])(20\d{2})([-_.]?)(0[1-9]|1[0-2])(?:\2(0[1-9]|[12][0-9]|3[01]))?(?![0-9])/;

/**
 * The month each venue is collected through, from the collector's published
 * tip. A venue with no tip has closed nothing and is skipped entirely.
 */
const readTips = (sharedRoot: string): Map<string, string> => {
  const found = new Map<string, string>();

  for (const [venue, file] of ledgers(sharedRoot)) {
    let tip = '';

    // Append-only, later lines superseding earlier ones. The highest wins, so a
    // torn write cannot lower a tip already acted on.
    for (const line of file.split('\n')) {
      const month = line.split('\t')[0]?.trim();

      if (month && /^\d{6}$/.test(month) && month > tip) tip = month;
    }

    if (tip) found.set(venue, tip);
  }

  return found;
};

/**
 * When the collector last closed each month.
 *
 * A month is closed once and normally stays closed, but the reasons it reopens
 * are real: a symbol universe that turns out to have been missing its delisted
 * names, a dataset never collected, a filename shape nobody knew about. When
 * that happens the month is walked again and closed again, with a new time —
 * and comparing that time is what brings the month back into view here.
 */
const readClosings = (sharedRoot: string): Map<string, string> => {
  const found = new Map<string, string>();

  for (const [venue, file] of ledgers(sharedRoot)) {
    // Append-only, later lines superseding earlier ones, so the last time a
    // month was closed is the one that counts.
    for (const line of file.split('\n')) {
      const [month, at] = line.split('\t');

      if (! month || ! at || ! /^\d{6}$/.test(month.trim())) continue;

      found.set(`${venue}/${month.trim()}`, at.trim());
    }
  }

  return found;
};

/**
 * The closing to compare against, for a month the ledger gives no time for.
 *
 * A sentinel rather than null, so such a month is still gated. Left ungated it
 * would be walked and compared on every run to reach the same answer, and the
 * point of the gate is to not do that.
 */
const closedAt = (closings: Map<string, string>, venue: string, month: string): string =>
  closings.get(`${venue}/${month}`) ?? '-';

const ledgers = (sharedRoot: string): [string, string][] => {
  const dir   = path.join(sharedRoot, 'complete');
  const found: [string, string][] = [];

  for (const file of readdir(dir)) {
    if (! file.endsWith('.tsv')) continue;

    found.push([file.replace(/\.tsv$/, ''), read(path.join(dir, file))]);
  }

  return found;
};

/**
 * Every file under a venue, depth-first, as paths relative to the source root.
 *
 * `@meta` is never entered: it is the collector's own bookkeeping, it is what
 * makes an evicted month safe from re-download, and it is tiny.
 *
 * **A directory named for a period after the tip is skipped whole.** Several
 * venues put the month or day in a directory — `spot/deals/202607/`,
 * `trades/daily/20260701/` — and those hold the bulk of a busy archive, all of
 * it too recent to pack. Recognising the name costs one regex and saves reading
 * the directory at all. Where a venue keeps the date only in the filename
 * nothing is pruned and the walk simply reads on.
 */
function* walk(sourceRoot: string, venue: string, tip: string): Generator<string> {
  const prefix = sourceRoot.endsWith('/') ? sourceRoot.length : sourceRoot.length + 1;
  const stack  = [path.join(sourceRoot, venue)];

  while (stack.length > 0) {
    const dir = stack.pop()!;

    // A venue can have a tip and no tree at all — every month of its archive
    // may predate what it publishes, or collection may not have written yet.
    for (const entry of entries(dir)) {
      if (entry.name === '@meta') continue;

      // Concatenated rather than `path.join`/`path.relative`: this runs a few
      // million times a scan, and those two dominated it — they normalise and
      // re-split a path already known to be well formed.
      const absolute = `${dir}/${entry.name}`;

      if (entry.isDirectory()) {
        const dated = datedDirectory(entry.name);

        if (dated && dated > tip) continue;

        stack.push(absolute);

        continue;
      }

      if (entry.isFile()) yield absolute.slice(prefix);
    }
  }
}

/**
 * What to say when a path cannot be dated.
 *
 * Examples over counts: the number says how bad it is, the paths say what it
 * *is*, and the shape is usually obvious the moment you see three of them side
 * by side. Ten is enough to tell one venue's quirk from a broader break.
 */
const undatedReport = (undated: string[]): string => {
  const venues = [...new Set(undated.map(relative => relative.split('/')[0]))].sort();

  return [
    `${undated.length.toLocaleString()} file${undated.length === 1 ? '' : 's'} carry no date this `
      + `can read, in: ${venues.join(', ')}`,
    '',
    'Every archive file has a date somewhere in its path, so this is a bug — either',
    'trucker collected files it should not have, or the date detection is too narrow.',
    'Nothing was planned; these files would silently never be backed up.',
    '',
    ...undated.slice(0, 10).map(relative => `    ${relative}`),
    ...(undated.length > 10 ? [`    … and ${(undated.length - 10).toLocaleString()} more`] : []),
  ].join('\n');
};

/** The month a directory is named for, when its name is a date and nothing else. */
const datedDirectory = (name: string): string | null => {
  if (/^\d{6}$/.test(name)) return name;
  if (/^\d{8}$/.test(name)) return name.slice(0, 6);

  return null;
};

const entries = (dir: string): fs.Dirent[] => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
};

const statOf = (absolute: string): fs.Stats | null => {
  try {
    return fs.statSync(absolute);
  } catch {
    return null;
  }
};

const readdir = (dir: string): string[] => {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
};

const read = (file: string): string => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_monthOf        = monthOf;
export const _test_readTips       = readTips;
export const _test_readClosings   = readClosings;
export const _test_datedDirectory = datedDirectory;

/**
 * How many walked entries between hands back to the event loop.
 *
 * Matched to the other walks in this family — the cost of a tick is
 * microseconds against thousands of directory reads, so there is nothing to
 * tune and the only thing it buys is a command that answers a signal.
 */
const BREATH = 2_000;

const breathe = (): Promise<void> => new Promise(resolve => { setImmediate(resolve); });
