import type { Collection } from 'mongodb';
import { BitmexTable, createTable } from '@devvir/bitmex-database';
import type { BitmexFieldType }     from '@devvir/bitmex-database';

import type { InstrumentItem, InstrumentMsg } from '../../types';
import type { InstrumentRunState }            from '../types';

import {
  getSeedState,
  hasSeedForDate,
  INSTRUMENT_KEYS,
  INSTRUMENT_TYPES,
  INSTRUMENT_FILTER,
} from './seeds';
import { makeId } from './ids';

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

/**
 * Create an empty run state. The accumulator table is unseeded — call
 * `seedRunState` before processing events so in-memory inserts/updates apply.
 */
export function createRunState(): InstrumentRunState {
  return {
    table:        createTable(BitmexTable.Instrument),
    rolling:      new Map(),
    symCache:     new Map(),
    refMap:       new Map(),
    knownSymbols: new Set(),
    deadSymbols:  new Set(),
    settled:      new Set(),
    lastCronMs:   undefined,
  };
}

/**
 * Seed the run state's accumulator with a `partial` message so subsequent
 * inserts/updates take effect (the underlying table silently ignores deltas
 * until a partial has been applied).
 *
 * Data source:
 *  - first-ever run (`resumeDay === coverageStart`)  → Tardis seed for that date
 *  - resume (`resumeDay > coverageStart`)            → resumeDay's own stored partial
 *  - resume with missing stored partial              → Tardis seed for resumeDay
 *  - nothing available                               → empty partial
 *
 * An empty partial still initialises the table and is the correct starting
 * state when pre-Tardis: inserts will populate it organically as vault events
 * arrive. Also rebuilds `refMap` and `knownSymbols` from the seeded snapshot.
 */
export async function seedRunState(
  coll:          Collection<InstrumentMsg>,
  state:         InstrumentRunState,
  resumeDay:     string,
  coverageStart: string,
): Promise<void> {
  const data = await loadSeedData(coll, resumeDay, coverageStart);

  state.table.apply({
    table:  BitmexTable.Instrument,
    action: 'partial',
    keys:   INSTRUMENT_KEYS as (keyof InstrumentItem & string)[],
    types:  INSTRUMENT_TYPES as Record<keyof InstrumentItem & string, BitmexFieldType>,
    filter: INSTRUMENT_FILTER as Record<keyof InstrumentItem & string, unknown>,
    data,
  });

  rebuildDerivedState(state);
}

/**
 * On Tardis monthly anchor dates, reset the accumulator with the full Tardis
 * snapshot — this brings the state back to a known-good baseline and picks
 * up any newly-listed or delisted symbols since the last anchor.
 *
 * Also syncs `symCache` from seed fields the vault doesn't supply (e.g. a
 * symbol's `lastPrice` at month start), and rebuilds `refMap` and
 * `knownSymbols`.
 */
export function applyMonthlyReset(state: InstrumentRunState, date: string): void {
  if (! hasSeedForDate(date)) return;

  const seedState = getSeedState(date);
  const seedData  = Array.from(seedState.values()) as InstrumentItem[];

  state.table.apply({
    table:  BitmexTable.Instrument,
    action: 'partial',
    keys:   INSTRUMENT_KEYS as (keyof InstrumentItem & string)[],
    types:  INSTRUMENT_TYPES as Record<keyof InstrumentItem & string, BitmexFieldType>,
    filter: INSTRUMENT_FILTER as Record<keyof InstrumentItem & string, unknown>,
    data:   seedData,
  });

  for (const [sym, fields] of seedState) {
    const entry = state.symCache.get(sym) ?? {};

    if (fields.lastPrice !== undefined) entry.lastPrice = fields.lastPrice;
    if (fields.markPrice !== undefined) entry.markPrice = fields.markPrice;
    if (fields.bidPrice  !== undefined) entry.bidPrice  = fields.bidPrice;
    if (fields.askPrice  !== undefined) entry.askPrice  = fields.askPrice;
    if (fields.tickSize  !== undefined) entry.tickSize  = fields.tickSize;

    state.symCache.set(sym, entry);
  }

  rebuildDerivedState(state);
}

/** Rebuild `refMap` and `knownSymbols` from the current accumulator snapshot. */
export function rebuildDerivedState(state: InstrumentRunState): void {
  const snapshot = state.table.snapshot();

  state.refMap       = buildRefMap(snapshot);
  state.knownSymbols = new Set(snapshot.map(i => i.symbol).filter((s): s is string => !! s));
}

/* ------------------------------------------------------------------ */
/*  Internals                                                          */
/* ------------------------------------------------------------------ */

async function loadSeedData(
  coll:          Collection<InstrumentMsg>,
  resumeDay:     string,
  coverageStart: string,
): Promise<InstrumentItem[]> {
  // First-ever run: Tardis if we have it, empty otherwise.
  if (resumeDay === coverageStart) {
    return Array.from(getSeedState(coverageStart).values()) as InstrumentItem[];
  }

  // Resume: load resumeDay's own partial — it was written before any events
  // for that day and contains exactly the state needed to re-run the day.
  const storedId = makeId(resumeDay, 0);
  const stored   = await coll.findOne({ _id: storedId });

  if (stored) return stored.data as InstrumentItem[];

  // Stored partial missing — fall back to Tardis for resumeDay.
  return Array.from(getSeedState(resumeDay).values()) as InstrumentItem[];
}

function buildRefMap(snapshot: InstrumentItem[]): Map<string, string[]> {
  const map = new Map<string, string[]>();

  for (const item of snapshot) {
    if (! item.referenceSymbol || ! item.symbol) continue;

    const existing = map.get(item.referenceSymbol);

    if (existing) {
      existing.push(item.symbol);
    } else {
      map.set(item.referenceSymbol, [item.symbol]);
    }
  }

  return map;
}
