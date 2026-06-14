import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { warn } from '../../../shared/ui/logger';

const execFileAsync = promisify(execFile);

let megaUnavailable = false;

// ── Exports ──────────────────────────────────────────────────────────────────

/**
 * List filenames in a Mega directory. Returns an empty set if the directory
 * doesn't exist, mega-cmd isn't installed, or the call otherwise fails.
 * After the first ENOENT-style failure, further calls short-circuit silently.
 */
export async function listMegaDir(dir: string): Promise<Set<string>> {
  if (megaUnavailable) return new Set();

  try {
    const { stdout } = await execFileAsync('mega-ls', [dir]);

    return new Set(stdout.split('\n').map(l => l.trim()).filter(Boolean));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;

    if (code === 'ENOENT') {
      megaUnavailable = true;
      warn('mega-ls not found — Mega checks/uploads disabled for this run');
    }

    return new Set();
  }
}

/** Whether the mega CLI is known to be unavailable for this run. */
export function isMegaUnavailable(): boolean {
  return megaUnavailable;
}

/**
 * Like `listMegaDir` but also returns the byte size of each entry. Uses
 * `mega-ls -l` and parses its tabular output. Returns an empty map on any
 * failure (mega-cmd missing, directory absent, parse error).
 *
 * `mega-ls -l` row format: `FLAGS  VERS  SIZE  DATE  TIME  NAME`
 */
export async function listMegaDirSized(dir: string): Promise<Map<string, number>> {
  if (megaUnavailable) return new Map();

  try {
    const { stdout } = await execFileAsync('mega-ls', ['-l', dir]);
    const result = new Map<string, number>();

    for (const line of stdout.split('\n')) {
      const m = line.match(/^\S+\s+\S+\s+(\d+)\s+\S+\s+\S+\s+(.+)$/);

      if (m) result.set(m[2].trim(), parseInt(m[1], 10));
    }

    return result;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;

    if (code === 'ENOENT') {
      megaUnavailable = true;
      warn('mega-ls not found — Mega checks/uploads disabled for this run');
    }

    return new Map();
  }
}

/**
 * List collection subdirectory names under a Mega dump base dir (one entry per
 * collection). Returns an empty list if Mega is unavailable or the base dir
 * doesn't exist — same fail-soft behaviour as `listMegaDir`.
 */
export async function listMegaCollections(base: string): Promise<string[]> {
  return [...await listMegaDir(base)].sort();
}

export function posixJoin(...parts: string[]): string {
  return parts.join('/').replace(/\/+/g, '/');
}

/**
 * Determine the backup "tip" for a Mega directory listing: the most recent
 * year or year-month that is fully backed up AND contiguous from the
 * earliest backup year (no gaps).
 *
 *   - A year is "complete" if a `YYYY.archive.gz` file exists, OR if all 12
 *     `YYYYMM.archive.gz` files for that year exist.
 *   - The tip is, in order of preference:
 *       1. the latest contiguous month inside the first incomplete year. The
 *          run starts at January when a complete year precedes it (so it stays
 *          contiguous with the prior December), otherwise it starts at the
 *          earliest month actually present — a collection whose backups begin
 *          mid-year (e.g. only `202604`) is not assumed to start in January;
 *       2. the latest fully-complete year before any gap.
 *
 * Returns `"YYYY"`, `"YYYY-MM"`, or `null` when nothing is contiguous from
 * the earliest backup. Day-granularity (YYYYMMDD) archives are ignored for
 * tip computation — they're either subsumed by a complete month or treated
 * as a gap.
 */
export function computeMegaTip(filenames: Set<string>): string | null {
  const yearKeys   = new Set<number>();
  const yearMonths = new Map<number, Set<number>>();

  for (const f of filenames) {
    const key = f.replace(/\.archive\.gz$/, '');

    if (/^\d{4}$/.test(key)) {
      yearKeys.add(parseInt(key, 10));
    } else if (/^\d{6}$/.test(key)) {
      const year  = parseInt(key.slice(0, 4), 10);
      const month = parseInt(key.slice(4, 6), 10);

      if (! yearMonths.has(year)) yearMonths.set(year, new Set());

      yearMonths.get(year)!.add(month);
    }
  }

  const isYearComplete = (year: number): boolean => {
    if (yearKeys.has(year)) return true;

    const months = yearMonths.get(year);

    return months !== undefined && months.size === 12;
  };

  const allYears = new Set<number>([...yearKeys, ...yearMonths.keys()]);

  if (allYears.size === 0) return null;

  const minYear = Math.min(...allYears);

  let lastCompleteYear: number | null = null;
  let year = minYear;

  while (isYearComplete(year)) {
    lastCompleteYear = year;
    year++;
  }

  // `year` now points at the first incomplete year. Find the longest run of
  // present months. The run starts at January only when a complete year
  // precedes it (to stay contiguous with that year's December); otherwise it
  // starts at the earliest month present, so backups that legitimately begin
  // mid-year are honoured rather than discarded.
  const incompleteMonths = yearMonths.get(year);

  if (incompleteMonths) {
    const startMonth = lastCompleteYear !== null ? 1 : Math.min(...incompleteMonths);

    let lastContiguousMonth = 0;

    for (let m = startMonth; m <= 12; m++) {
      if (incompleteMonths.has(m)) lastContiguousMonth = m;
      else                          break;
    }

    if (lastContiguousMonth > 0) {
      return `${year}-${String(lastContiguousMonth).padStart(2, '0')}`;
    }
  }

  return lastCompleteYear !== null ? String(lastCompleteYear) : null;
}
