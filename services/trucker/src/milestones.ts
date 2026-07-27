import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import config from './config';

/**
 * What trucker has finished collecting, published for anything downstream.
 *
 * A consumer of the archive can see which files exist but not whether more are
 * coming, and that difference decides whether a month is safe to process. The
 * knowledge is trucker's alone — it is the only thing that knows a period is
 * settled, meaning every file covering it and every earlier one has landed or
 * been established as never published.
 *
 * So it is written down where a consumer can read it: one line per dataset and
 * symbol, holding the date collection is complete through.
 *
 *     spot-deals\tBTC_USDT\t20180531
 *
 * "Is 2018-05 ready?" is then `endOfMonth('201805') <= settled`, with no
 * inspection of the tree and no guessing from file counts.
 *
 * The format is deliberately dull — tab-separated text, append-only, later
 * lines superseding earlier ones. Tabs because venue symbols contain nearly
 * every other punctuation character (`BSV*(-3)-USDT`, `人生K线-USDT`), and one
 * file per venue because venues are walked concurrently and would otherwise
 * append over each other.
 *
 * It is also trucker's own progress cursor — where each symbol resumes from.
 * The two were separate records holding the same number, written one after the
 * other on every symbol, which bought nothing but a way for them to disagree
 * after a crash. One record cannot drift from itself.
 *
 * That makes the file the record of progress as well as the published contract,
 * so the ordering rule below is no longer a rule but an impossibility: there is
 * nothing to write second.
 */

const DIR = () => join(config.dataDir, '@meta', 'settled');

const fileFor = (venue: string): string => join(DIR(), `${venue}.tsv`);

/** Key within a venue's file. */
const keyOf = (dataset: string, symbol: string): string => `${dataset}\t${symbol}`;

/** One in-memory copy per venue — see `cached`. */
const memo = new Map<string, Promise<Map<string, string>>>();

/**
 * Every milestone a venue has published, as `dataset\tsymbol` → `yyyymmdd`.
 *
 * Read once at startup and kept in memory: a line is only written when the
 * value it carries is new, so the file grows with progress rather than with
 * passes. A first run against an existing archive therefore writes one line per
 * symbol and records everything already collected, with no migration step.
 */
export const load = async (venue: string): Promise<Map<string, string>> => {
  const known = new Map<string, string>();
  const raw   = await readFile(fileFor(venue), 'utf8').catch(() => '');

  for (const line of raw.split('\n')) {
    const parts = line.split('\t');

    if (parts.length !== 3) continue;

    const [dataset, symbol, settled] = parts as [string, string, string];

    known.set(keyOf(dataset, symbol), settled.trim());
  }

  return known;
};

/**
 * The venue's milestones, read once and held for the life of the process.
 *
 * A sweep asks per dataset, which on Gate is 22 times over a 2,684-line file,
 * and the answer cannot change behind trucker's back: it is the only writer,
 * and `publish` keeps the map in step with the file as it appends. The promise
 * rather than the map is memoised, so venues starting concurrently share one
 * read instead of racing to do their own.
 */
export const cached = (venue: string): Promise<Map<string, string>> => {
  const held = memo.get(venue);

  if (held) return held;

  const loading = load(venue);

  memo.set(venue, loading);

  return loading;
};

/** Where a symbol stands: the last day collection is complete through. */
export const settled = (
  known:   Map<string, string>,
  dataset: string,
  symbol:  string,
): string | null => known.get(keyOf(dataset, symbol)) ?? null;

/**
 * Publish that a symbol is collected through `settled`, if that is news.
 *
 * Returns whether a line was written, so a caller can tell a milestone from a
 * repeat.
 */
export const publish = async (
  venue:   string,
  dataset: string,
  symbol:  string,
  settled: string,
  known:   Map<string, string>,
): Promise<boolean> => {
  const key     = keyOf(dataset, symbol);
  const current = known.get(key);

  // Only ever moves forward: an out-of-order pass must not retract a milestone
  // a consumer may already have acted on.
  if (current && current >= settled) return false;

  const path = fileFor(venue);

  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${dataset}\t${symbol}\t${settled}\n`);

  known.set(key, settled);

  return true;
};
