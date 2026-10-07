import { asSeries } from '../paths';
import { html } from '../scanners/html';
import { listing, surveying } from '../context';
import type { Adapter, Inspection } from '../types';
import { bybitInstruments } from './bybit/instruments';
import { declare } from './declare';

/**
 * Bybit's order books, on a server of their own: another address, another tree,
 * browsable indexes and its own limiter. Described in `docs/venues/BYBIT.md`.
 */
export const bybitSecondary: Adapter = declare({
  /** The shared listing context — this venue differs by address, not by shape. */
  getContext: async () => listing(bybitSecondary),

  name:    'bybit',
  host:    'secondary',
  scanner: html,

  /** The index names files and states nothing else, so every key is probed. */
  probes:  true,

  /**
   * On a walk an index named the key, so a `404` is asked again many times; on an
   * update it was a guess, and is not.
   */
  ruleOnFailure: (_row, status, _headers, tries) =>
    (status === 404 && surveying(bybitSecondary) === 'walk' && tries < INDEXED_TRIES
      ? 'keep'
      : null),

  /** No limit was found on this host — measured in `docs/venues/BYBIT.md`. */
  pacing:  { perSecond: 5000, concurrency: 500 },

  /** Days behind today a probing pass stops asking: the venue's measured publishing delay, and a day more. */
  probingLag: 3,

  /** What bybit lists today — see `bybit/instruments.ts`. */
  instruments: async (db) => bybitInstruments(db, 'secondary'),

  /** Reading this venue's paths back into series — see `paths.ts`. */
  inspectUrl: (path) => inspect(path),

  /** The first date in the filename. */
  dateOf: (path) => {
    const day = /(\d{4})-(\d{2})-(\d{2})/.exec(path.slice(path.lastIndexOf('/') + 1));

    return day ? `${day[1]}${day[2]}${day[3]}` : null;
  },
});

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * Read `linear/BTCUSDT/2025-08-21_BTCUSDT_ob200.data.zip`: the date leads, the
 * depth closes, and the instrument is what lies between.
 */
const inspect = (path: string): Inspection => {
  const found = BOOKS.exec(path);

  if (! found) return { of: 'unknown', date: null };

  const { symbol, depth, date } = found.groups!;

  /**
   * Both book markets are perpetual swaps, and the depth is the variant: a symbol
   * has files of two depths.
   */
  return asSeries(path, {
    market:  'perp',
    dataset: 'books',
    variant: `incremental,${depth}`,
    symbol:  symbol!,
    date:    date!,
  });
};

const BOOKS = new RegExp(
  '^(?<market>linear|inverse)/[^/]+'
  + '/(?<date>\\d{4}-\\d{2}-\\d{2})_(?<symbol>[A-Za-z0-9_-]+)_ob(?<depth>\\d+)\\.data\\.zip$');

/** How often a key an index named may answer `404` before it is written off. */
const INDEXED_TRIES = 100;
