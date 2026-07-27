import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import config from './config';

/**
 * How far each symbol has been **looked at**, as opposed to how far data was
 * found for it.
 *
 * The milestone beside this one only ever advances when a file lands, so for a
 * symbol that stopped publishing it freezes at its final file for ever — a
 * symbol delisted in 2017 reads `20170930` no matter how many sweeps pass over
 * it. Nothing on disk then distinguishes "everything it ever published is
 * collected, and that was the end of it" from "collection has not got past
 * 2017 yet", and the two demand opposite answers to the only question a
 * consumer asks:
 *
 *     is this month complete for **every** symbol?
 *
 * Taking the minimum milestone across a dataset answers it wrongly, pinned for
 * ever by whichever symbol died first. Coverage answers it directly: a symbol
 * the venue was asked about, through a date whose absences are permanent, is
 * complete through that date whether it published nothing, something or
 * everything.
 *
 *     spot-trades\tELCBTC\t20260803      looked at, through 3 August
 *     spot-trades\tELCBTC\t20170930      (settled) last file it ever published
 *
 * A dataset-month is then complete when every symbol's coverage reaches the
 * month's last day, with no inspection of the tree and no per-venue knowledge
 * of which symbols are alive.
 *
 * Same dull format as the ledgers beside it — tab-separated, append-only, later
 * lines superseding earlier ones, one file per venue because venues are walked
 * concurrently and would otherwise append over each other.
 */

const DIR = () => join(config.dataDir, '@meta', 'covered');

const fileFor = (venue: string): string => join(DIR(), `${venue}.tsv`);

const keyOf = (dataset: string, symbol: string): string => `${dataset}\t${symbol}`;

/** One in-memory copy per venue — see `cached`. */
const memo = new Map<string, Promise<Map<string, string>>>();

export const load = async (venue: string): Promise<Map<string, string>> => {
  const known = new Map<string, string>();
  const raw   = await readFile(fileFor(venue), 'utf8').catch(() => '');

  for (const line of raw.split('\n')) {
    const parts = line.split('\t');

    if (parts.length !== 3) continue;

    const [dataset, symbol, through] = parts as [string, string, string];

    known.set(keyOf(dataset, symbol), through.trim());
  }

  return known;
};

/**
 * The venue's coverage, read once and held for the life of the process. Same
 * reasoning as the ledgers beside it: asked per dataset, changed only by this
 * process, and `publish` keeps the map in step with the file.
 */
export const cached = (venue: string): Promise<Map<string, string>> => {
  const held = memo.get(venue);

  if (held) return held;

  const loading = load(venue);

  memo.set(venue, loading);

  return loading;
};

/** How far a symbol has been looked at, or null when it never has. */
export const covered = (
  known:   Map<string, string>,
  dataset: string,
  symbol:  string,
): string | null => known.get(keyOf(dataset, symbol)) ?? null;

/**
 * Record that a symbol has been looked at through `through`, if that is news.
 *
 * Only ever moves forward: an out-of-order pass must not retract coverage a
 * consumer may already have acted on.
 */
export const publish = async (
  venue:   string,
  dataset: string,
  symbol:  string,
  through: string,
  known:   Map<string, string>,
): Promise<boolean> => {
  const key     = keyOf(dataset, symbol);
  const current = known.get(key);

  if (current && current >= through) return false;

  const path = fileFor(venue);

  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${dataset}\t${symbol}\t${through}\n`);

  known.set(key, through);

  return true;
};

/**
 * The date a whole venue has been looked at through: the lowest coverage across
 * every symbol of every dataset it publishes.
 *
 * Null when any symbol has no coverage at all — one symbol never walked means
 * the venue's oldest months cannot be claimed complete, and guessing otherwise
 * is the one mistake that cannot be taken back.
 */
export const lowest = async (
  venue:    string,
  universe: Map<string, Set<string>>,
): Promise<string | null> => {
  const known = await cached(venue);

  let floor: string | null = null;

  for (const [dataset, symbols] of universe) {
    for (const symbol of symbols) {
      const through = known.get(keyOf(dataset, symbol));

      if (! through) return null;
      if (! floor || through < floor) floor = through;
    }
  }

  return floor;
};

/**
 * Seed coverage from the milestones already on disk, for symbols that have none.
 *
 * An archive collected before this ledger existed carries the knowledge only
 * implicitly: a symbol with a milestone was demonstrably looked at at least as
 * far as the data that landed. That is the strongest claim the older record
 * supports, and it is deliberately the weakest of the two readings — a delisted
 * symbol is seeded at its final file rather than at today, so a month after its
 * delisting stays incomplete until a real sweep says otherwise.
 *
 * Under-claiming that way costs one pass. Over-claiming would publish a month as
 * complete on the strength of a guess.
 *
 * Idempotent: symbols that already have coverage are left alone, so a restart
 * that finds a full ledger writes nothing.
 */
export const backfill = async (
  venue:   string,
  settled: Map<string, string>,
): Promise<number> => {
  const known = await cached(venue);

  let seeded = 0;

  for (const [key, through] of settled) {
    if (known.has(key)) continue;

    const [dataset, symbol] = key.split('\t') as [string, string];

    if (await publish(venue, dataset, symbol, through, known)) seeded++;
  }

  return seeded;
};
