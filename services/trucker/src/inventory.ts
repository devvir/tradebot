import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import config from './config';
import { dashed, dashedMonth, endOfMonth, nextDay, nextMonth } from './dates';
import type {
  ArchiveFile, DateStyle, InventoryChange, InventoryShape, Period,
} from './types';

/**
 * What a venue publishes, written down once so it is never asked twice.
 *
 * An archive below its trailing edge does not change: a venue adds files near
 * the present and effectively never far from it. So "which dates does this
 * symbol publish?" has a permanent answer, and the month-major walk — which
 * asks it once per symbol **per month** and keeps one month of the reply — pays
 * for the same answer a hundred times over. On binance that is not a
 * inefficiency but a wall: a single symbol's kline listing runs to ~87 pages,
 * and no month ever finishes.
 *
 * This ledger is that answer. One enumeration per symbol fills it; every month
 * afterwards is served from disk with no request at all.
 *
 * **It says what the venue has, never what we hold.** The filesystem answers
 * the second question, and keeping them apart is what makes a re-run cost
 * `stat` calls rather than downloads.
 *
 * ## Shape
 *
 * Keys are reduced to a template by lifting the date out of them, so ten years
 * of daily files become two strings and a range. The template is *derived from
 * the keys themselves* and verified by rendering it back: any key that does not
 * reproduce exactly is kept verbatim instead. Nothing is assumed about how a
 * venue names its files, which matters — bitget publishes the same series under
 * two different names in the same week.
 *
 * Same dull format as the ledgers beside it: tab-separated, append-only, later
 * lines superseding earlier ones. One file per venue **per dataset**, because a
 * venue's inventory is the largest thing under `@meta/` and a walk only ever
 * needs the dataset in hand.
 */

const DIR = () => join(config.dataDir, '@meta', 'inventory');

const fileFor = (venue: string, dataset: string): string =>
  join(DIR(), venue, `${dataset}.tsv`);

const keyOf = (shape: InventoryShape): string =>
  `${shape.symbol}\t${shape.period}\t${shape.url}`;

/** One in-memory copy per venue and dataset — see `cached`. */
const memo = new Map<string, Promise<Map<string, InventoryShape>>>();

/**
 * The dataset's inventory, read once and held for the life of the process.
 * Same reasoning as the ledgers beside it: asked per symbol, changed only by
 * this process, and `record` keeps the map in step with the file.
 */
export const cached = (
  venue:   string,
  dataset: string,
): Promise<Map<string, InventoryShape>> => {
  const id   = `${venue}\t${dataset}`;
  const held = memo.get(id);

  if (held) return held;

  const loading = load(venue, dataset);

  memo.set(id, loading);

  return loading;
};

export const load = async (
  venue:   string,
  dataset: string,
): Promise<Map<string, InventoryShape>> => {
  const known = new Map<string, InventoryShape>();
  const raw   = await readFile(fileFor(venue, dataset), 'utf8').catch(() => '');

  for (const line of raw.split('\n')) {
    const parts = line.split('\t');

    if (parts.length !== 7) continue;

    const [symbol, period, style, url, path, runs, asOf] =
      parts as [string, string, string, string, string, string, string];

    const shape: InventoryShape = {
      symbol,
      period:   period as Period,
      style:    style === '' ? null : style as DateStyle,
      url,
      path,
      runs:     parseRuns(runs),
      asOf:     asOf.trim(),
    };

    known.set(keyOf(shape), shape);
  }

  return known;
};

/**
 * Fold a listing into the ledger, replacing what each shape knew before.
 *
 * A shape is rewritten rather than merged because a listing is authoritative
 * for the span it covers: the venue was asked and this is what it answered. A
 * refresh that starts part-way in therefore hands back what it already held
 * for the earlier span — see `merge` — instead of narrowing the record to the
 * window it happened to ask about.
 */
export const record = async (
  venue:   string,
  dataset: string,
  shapes:  InventoryShape[],
  known:   Map<string, InventoryShape>,
): Promise<void> => {
  if (shapes.length === 0) return;

  const path = fileFor(venue, dataset);
  const rows = shapes.map(shape => [
    shape.symbol,
    shape.period,
    shape.style ?? '',
    shape.url,
    shape.path,
    formatRuns(shape.runs),
    shape.asOf,
  ].join('\t')).join('\n');

  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${rows}\n`);

  for (const shape of shapes) known.set(keyOf(shape), shape);
};

/**
 * Reduce a listing to the shapes it contains.
 *
 * Every file is matched against its own key: the date is rendered in each style
 * the venue might have used and looked for in the URL and the path. Whichever
 * renders back to exactly the key it came from wins, so a template is only ever
 * adopted once it has been proven to reproduce real keys. A file that matches
 * nothing becomes its own single-date shape, verbatim.
 */
export const shapesOf = (files: readonly ArchiveFile[], asOf: string): InventoryShape[] => {
  const shapes = new Map<string, InventoryShape>();

  for (const file of files) {
    const stamp = stampOf(file);
    const style = styleOf(file, stamp);

    const url  = style ? lift(file.url,  stamp, style) : file.url;
    const path = style ? lift(file.path, stamp, style) : file.path;

    const id    = `${file.symbol}\t${file.period}\t${url}`;
    const shape = shapes.get(id) ?? {
      symbol:   file.symbol,
      period:   file.period,
      style,
      url,
      path,
      runs:     [] as [string, string][],
      asOf,
    };

    // Runs hold the **canonical** stamp — `yyyymmdd`, or `yyyymm` for a monthly
    // shape — never the venue's rendering of it. Stepping a run is date
    // arithmetic, and `2026-07-01` is not a date any more than `{d}` is.
    push(shape.runs, stamp, file.period);
    shapes.set(id, shape);
  }

  return [...shapes.values()];
};

/**
 * Carry forward what a shape already knew, for a refresh that only asked about
 * recent dates.
 *
 * Without this a tip refresh would shrink a ten-year history to the fortnight
 * it enquired about, and the walk would then believe the older files never
 * existed — which is exactly the kind of quiet loss this ledger exists to stop.
 */
export const merge = (
  fresh: InventoryShape[],
  known: Map<string, InventoryShape>,
): InventoryShape[] =>
  fresh.map((shape) => {
    const held = known.get(keyOf(shape));

    if (! held) return shape;

    const runs: [string, string][] = [];

    for (const [from, to] of [...held.runs, ...shape.runs])
      pushRange(runs, from, to, shape.period);

    return { ...shape, runs };
  });

/**
 * How a fresh listing contradicts what the ledger already held.
 *
 * The whole design rests on the archive below the tip not changing, and that
 * assumption is load-bearing: a closed month is published as final, tarred into
 * cold storage, and built into partitions. So a listing is **diffed before it is
 * merged**, and anything that is not "new files at the tip" is reported rather
 * than silently absorbed.
 *
 * Only what the venue was just **asked** about is judged, which is everything
 * after `since` — not merely the span it returned files for. A refresh that
 * enquired about last week says nothing about 2019, and reading its silence
 * there as a retraction would cry wolf on every pass; but a full re-enumeration
 * (`since` null) is asked about everything, so files it no longer lists have
 * genuinely been withdrawn. Judging by what came back instead would miss
 * exactly the case worth catching — a venue pruning its oldest files.
 *
 * Additions after the newest date already held are ordinary growth and are not
 * reported. Everything else is: dates withdrawn, history appearing below what
 * the shape used to start at, a hole quietly filling in, or a new filename
 * shape covering dates already collected under another one.
 */
export const changes = (
  fresh: readonly InventoryShape[],
  known: Map<string, InventoryShape>,
  since: string | null = null,
): InventoryChange[] => {
  const found: InventoryChange[] = [];

  for (const shape of fresh) {
    const held = known.get(keyOf(shape));

    if (! held) {
      // A shape nobody has seen before is only news if it covers history that
      // was already being collected under a different name.
      const newest = publishedThrough(known, shape.symbol);
      const first  = shape.runs[0]?.[0];

      if (newest && first && stampDate(first, shape.period) <= newest)
        report(found, shape.symbol, 'reshaped', spanOf(shape));

      continue;
    }

    const heldFirst = held.runs[0]?.[0];
    const heldLast  = held.runs[held.runs.length - 1]?.[1];

    const withdrawn = missing(held.runs, shape.runs, shape.period)
      .filter(stamp => ! since || stampDate(stamp, shape.period) > since);

    report(found, shape.symbol, 'removed', gaps(withdrawn));

    for (const [start, end] of gaps(missing(shape.runs, held.runs, shape.period))) {
      if (heldLast && start > heldLast) continue;          // ordinary growth
      if (heldFirst && end < heldFirst) report(found, shape.symbol, 'backfilled', [start, end]);
      else report(found, shape.symbol, 'infilled', [start, end]);
    }
  }

  return found;
};

/** Note a contradiction where a human will find it without reading the logs. */
export const flag = async (
  venue:   string,
  dataset: string,
  found:   readonly InventoryChange[],
): Promise<void> => {
  if (found.length === 0) return;

  const path = join(config.sharedDir, 'changes', `${venue}.tsv`);
  const at   = new Date().toISOString();
  const rows = found
    .map(c => [dataset, c.symbol, c.kind, c.from, c.to, at].join('\t'))
    .join('\n');

  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${rows}\n`);
};

/**
 * The files a symbol publishes within `[from, to]`, rebuilt from the ledger.
 *
 * Both bounds are `yyyymmdd` and compare against the file's own coverage date —
 * a monthly file is keyed by the last day of its month, exactly as a listing
 * would have reported it, so the walk cannot tell the difference between this
 * and having asked the venue.
 */
export const filesIn = (
  known:     Map<string, InventoryShape>,
  symbol:    string,
  from:      string | null,
  to:        string,
  /** Whether this venue ships a `.CHECKSUM` beside every file. */
  checksums = false,
): ArchiveFile[] => {
  const files: ArchiveFile[] = [];

  for (const shape of known.values()) {
    if (shape.symbol !== symbol) continue;

    for (const [start, end] of shape.runs) {
      for (const stamp of steps(start, end, shape.period)) {
        const date = shape.period === 'monthly' && stamp.length === 6
          ? endOfMonth(stamp)
          : stamp;

        if (date > to) break;
        if (from && date <= from) continue;

        files.push(materialise(shape, stamp, date, checksums));
      }
    }
  }

  return files.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
};

/** The newest date any shape of this symbol publishes, or null when unknown. */
export const publishedThrough = (
  known:  Map<string, InventoryShape>,
  symbol: string,
): string | null => {
  let newest: string | null = null;

  for (const shape of known.values()) {
    if (shape.symbol !== symbol) continue;

    const last  = shape.runs[shape.runs.length - 1];

    if (! last) continue;

    const stamp = last[1];
    const date  = shape.period === 'monthly' && stamp.length === 6
      ? endOfMonth(stamp)
      : stamp;

    if (! newest || date > newest) newest = date;
  }

  return newest;
};

/** Whether the venue has ever been asked about this symbol. */
export const enumerated = (
  known:  Map<string, InventoryShape>,
  symbol: string,
): boolean => {
  for (const shape of known.values()) if (shape.symbol === symbol) return true;

  return false;
};

/** When this symbol was last asked about, or null when it never has been. */
export const askedAt = (
  known:  Map<string, InventoryShape>,
  symbol: string,
): string | null => {
  let oldest: string | null = null;

  for (const shape of known.values()) {
    if (shape.symbol !== symbol) continue;
    if (! oldest || shape.asOf < oldest) oldest = shape.asOf;
  }

  return oldest;
};

// ── Internals ─────────────────────────────────────────────────────────────────

/** Stamps present in `a` and absent from `b`, in order. */
const missing = (
  a:      readonly [string, string][],
  b:      readonly [string, string][],
  period: Period,
): string[] => {
  const held = new Set<string>();

  for (const [from, to] of b) for (const stamp of steps(from, to, period)) held.add(stamp);

  const out: string[] = [];

  for (const [from, to] of a)
    for (const stamp of steps(from, to, period)) if (! held.has(stamp)) out.push(stamp);

  return out;
};

/** Consecutive stamps collapsed back into `[from, to]` pairs for reporting. */
const gaps = (stamps: readonly string[]): [string, string][] => {
  const runs: [string, string][] = [];

  for (const stamp of stamps) {
    const last = runs[runs.length - 1];

    if (last && (stamp === nextDay(last[1]) || stamp === nextMonth(last[1]))) last[1] = stamp;
    else runs.push([stamp, stamp]);
  }

  return runs;
};

const spanOf = (shape: InventoryShape): [string, string] | null => {
  const first = shape.runs[0]?.[0];
  const last  = shape.runs[shape.runs.length - 1]?.[1];

  return first && last ? [first, last] : null;
};

const report = (
  into:   InventoryChange[],
  symbol: string,
  kind:   InventoryChange['kind'],
  spans:  [string, string][] | [string, string] | null,
): void => {
  if (! spans) return;

  const list = typeof spans[0] === 'string'
    ? [spans as [string, string]]
    : spans as [string, string][];

  for (const [from, to] of list) into.push({ symbol, kind, from, to });
};

/** A run stamp as the date the walk compares — a month keys to its last day. */
const stampDate = (stamp: string, period: Period): string =>
  period === 'monthly' && stamp.length === 6 ? endOfMonth(stamp) : stamp;

/** The date as it appears in this file's own key, before any re-keying. */
const stampOf = (file: ArchiveFile): string =>
  file.period === 'monthly' ? file.date.slice(0, 6) : file.date;

/**
 * Which rendering of the date this key actually uses.
 *
 * Monthly keys are tried at both month forms and daily at both day forms; a
 * monthly file whose key carries a full day (some venues date a month by its
 * first day) still matches, because the file's own date is tried too.
 */
const styleOf = (file: ArchiveFile, stamp: string): DateStyle | null => {
  const candidates: [DateStyle, string][] = file.period === 'monthly'
    ? [['ym', stamp], ['y-m', dashedMonth(stamp)],
       ['ymd', file.date], ['y-m-d', dashed(file.date)]]
    : [['ymd', stamp], ['y-m-d', dashed(stamp)]];

  for (const [style, text] of candidates) {
    if (! file.url.includes(text) || ! file.path.includes(text)) continue;

    // Proven, not assumed: the template must rebuild the key it came from.
    const url  = lift(file.url,  stamp, style);
    const path = lift(file.path, stamp, style);

    if (fill(url, text) === file.url && fill(path, text) === file.path) return style;
  }

  return null;
};

const render = (stamp: string, style: DateStyle): string => {
  if (style === 'ymd')   return stamp;
  if (style === 'y-m-d') return dashed(stamp);
  if (style === 'ym')    return stamp.slice(0, 6);

  return dashedMonth(stamp.slice(0, 6));
};

const lift = (text: string, stamp: string, style: DateStyle): string =>
  text.split(render(stamp, style)).join(PLACEHOLDER);

const fill = (template: string, text: string): string =>
  template.split(PLACEHOLDER).join(text);

const PLACEHOLDER = '{d}';

const materialise = (
  shape:     InventoryShape,
  stamp:     string,
  date:      string,
  checksums: boolean,
): ArchiveFile => {
  const text = shape.style ? render(stamp, shape.style) : '';
  const url  = shape.style ? fill(shape.url,  text) : shape.url;
  const path = shape.style ? fill(shape.path, text) : shape.path;

  return {
    url,
    path,
    date,
    symbol: shape.symbol,
    period: shape.period,
    ...(checksums ? { checksumUrl: `${url}.CHECKSUM` } : {}),
  };
};

/** Every stamp from `start` to `end` inclusive, stepping by the shape's period. */
const steps = (start: string, end: string, period: Period): string[] => {
  const out: string[] = [];
  const step = period === 'monthly' && start.length === 6 ? nextMonth : nextDay;

  let at = start;

  // A malformed run must not spin forever; the ledger is only ever written by
  // this service, but it is a plain text file on disk.
  for (let guard = 0; at <= end && guard < 100_000; guard++) {
    out.push(at);
    at = step(at);
  }

  return out;
};

const push = (runs: [string, string][], stamp: string, period: Period): void =>
  pushRange(runs, stamp, stamp, period);

/**
 * Add a range, keeping the list ascending, non-overlapping and coalesced.
 *
 * Runs are what make the ledger small — a decade of unbroken daily files is one
 * pair — so anything that would leave two adjacent ranges side by side is
 * folded back together.
 */
const pushRange = (
  runs:   [string, string][],
  from:   string,
  to:     string,
  period: Period,
): void => {
  const step = period === 'monthly' && from.length === 6 ? nextMonth : nextDay;
  const last = runs[runs.length - 1];

  if (! last) {
    runs.push([from, to]);

    return;
  }

  if (from < last[0]) {
    runs.push([from, to]);
    runs.sort(([a], [b]) => (a < b ? -1 : 1));

    return coalesce(runs, period);
  }

  // Inside what is already known, or the very next stamp — extend rather than
  // start a second range.
  if (from <= last[1] || from === step(last[1])) {
    if (to > last[1]) last[1] = to;

    return;
  }

  runs.push([from, to]);
};

const coalesce = (runs: [string, string][], period: Period): void => {
  const step = period === 'monthly' && runs[0]![0].length === 6 ? nextMonth : nextDay;

  for (let i = runs.length - 1; i > 0; i--) {
    const prev = runs[i - 1]!;
    const here = runs[i]!;

    if (here[0] > step(prev[1])) continue;

    if (here[1] > prev[1]) prev[1] = here[1];

    runs.splice(i, 1);
  }
};

const formatRuns = (runs: readonly [string, string][]): string =>
  runs.map(([from, to]) => (from === to ? from : `${from}-${to}`)).join(',');

const parseRuns = (raw: string): [string, string][] =>
  raw.split(',').filter(Boolean).map((run) => {
    const [from, to] = run.split('-') as [string, string?];

    return [from, to ?? from] as [string, string];
  });

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_reset      = (): void => memo.clear();
export const _test_formatRuns = formatRuns;
export const _test_parseRuns  = parseRuns;
export const _test_steps      = steps;
