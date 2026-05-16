import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { Collection }                        from 'mongodb';
import { BitmexTable }                           from '@devvir/bitmex-database';

import type { InstrumentMsg }        from '../../../src/types';
import type { InstrumentTaggedEvent } from '../../../src/distillers/types';

vi.mock('../../../src/distillers/instrument/seeds', () => ({
  getFirstSeedForSymbol: vi.fn(),
  getSeedState:          vi.fn(() => new Map()),
  hasSeedForDate:        vi.fn(() => false),
  INSTRUMENT_KEYS:       ['symbol'],
  INSTRUMENT_TYPES:      {},
  INSTRUMENT_FILTER:     {},
}));

import { processDayEvents }             from '../../../src/distillers/instrument/events';
import { createRunState, seedRunState } from '../../../src/distillers/instrument/state';
import { getFirstSeedForSymbol }        from '../../../src/distillers/instrument/seeds';
import type { InstrumentRunState }      from '../../../src/distillers/types';

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/**
 * Create a run state whose table is primed with an empty partial so that
 * insert/update messages applied by processDayEvents take effect without
 * triggering "update for non-existing item" warnings from bitmex-database.
 */
function makeState(initialItems: Array<{ symbol: string }> = []): InstrumentRunState {
  const state = createRunState();

  state.table.apply({
    table:  BitmexTable.Instrument,
    action: 'partial',
    keys:   ['symbol'] as any,
    types:  {} as any,
    filter: {} as any,
    data:   initialItems as any,
  });

  for (const item of initialItems) {
    state.knownSymbols.add(item.symbol);
  }

  return state;
}

/** Minimal quote-source tagged event. */
function quoteEvent(opts: {
  symbol?:    string;
  ms?:        number;
  id?:        number;
  bidPrice?:  number;
  askPrice?:  number;
  timestamp?: string;
} = {}): InstrumentTaggedEvent {
  const symbol    = opts.symbol    ?? 'XBTUSD';
  const ms        = opts.ms        ?? 1_000;
  const id        = opts.id        ?? 1;
  const bidPrice  = opts.bidPrice  ?? 3600;
  const askPrice  = opts.askPrice  ?? 3601;
  const timestamp = opts.timestamp ?? '2019-01-01T00:00:01.000Z';

  return {
    source: 'quote',
    ms,
    _id:    id,
    row: {
      _id:      id,
      timestamp,
      symbol,
      bidPrice,
      askPrice,
    } as any,
  };
}

/* ------------------------------------------------------------------ */
/*  processDayEvents — new symbol (insert)                            */
/* ------------------------------------------------------------------ */

describe('processDayEvents — new symbol', () => {
  let state: InstrumentRunState;

  beforeEach(() => {
    vi.clearAllMocks();
    state = makeState();
  });

  it('emits an insert doc when a symbol appears for the first time', () => {
    vi.mocked(getFirstSeedForSymbol).mockReturnValue({ symbol: 'XBTUSD', tickSize: 0.5 });

    const docs = Array.from(processDayEvents(state, '2019-01-01', [quoteEvent()]));

    expect(docs).toHaveLength(1);
    expect(docs[0]!.action).toBe('insert');
  });

  it('merges Tardis semi-static fields with vault source fields', () => {
    vi.mocked(getFirstSeedForSymbol).mockReturnValue({
      symbol:  'XBTUSD',
      tickSize: 0.5,
      lotSize:  100,
    });

    const docs = Array.from(processDayEvents(state, '2019-01-01', [quoteEvent({ bidPrice: 3600, askPrice: 3601 })]));

    expect(docs[0]!.data[0]).toMatchObject({
      symbol:   'XBTUSD',
      bidPrice: 3600,
      askPrice: 3601,
      tickSize: 0.5,
      lotSize:  100,
    });
  });

  it('vault fields override Tardis where they overlap', () => {
    vi.mocked(getFirstSeedForSymbol).mockReturnValue({
      symbol:   'XBTUSD',
      bidPrice: 1,   // stale Tardis value
      askPrice: 2,   // stale Tardis value
      tickSize: 0.5,
    });

    const docs = Array.from(processDayEvents(state, '2019-01-01', [quoteEvent({ bidPrice: 3600, askPrice: 3601 })]));

    expect(docs[0]!.data[0]).toMatchObject({ bidPrice: 3600, askPrice: 3601, tickSize: 0.5 });
  });

  it('queries Tardis from the current day forward', () => {
    vi.mocked(getFirstSeedForSymbol).mockReturnValue({ symbol: 'XBTUSD' });

    Array.from(processDayEvents(state, '2019-06-15', [quoteEvent()]));

    expect(getFirstSeedForSymbol).toHaveBeenCalledWith('XBTUSD', '2019-06-15');
  });

  it('adds the symbol to knownSymbols after the first insert', () => {
    vi.mocked(getFirstSeedForSymbol).mockReturnValue({ symbol: 'XBTUSD' });

    Array.from(processDayEvents(state, '2019-01-01', [quoteEvent()]));

    expect(state.knownSymbols.has('XBTUSD')).toBe(true);
  });

  it('computes midPrice from bid and ask', () => {
    vi.mocked(getFirstSeedForSymbol).mockReturnValue({ symbol: 'XBTUSD' });

    const docs = Array.from(processDayEvents(state, '2019-01-01', [quoteEvent({ bidPrice: 3600, askPrice: 3602 })]));

    expect(docs[0]!.data[0]).toMatchObject({ midPrice: 3601 });
  });
});

/* ------------------------------------------------------------------ */
/*  processDayEvents — known symbol (update)                          */
/* ------------------------------------------------------------------ */

describe('processDayEvents — known symbol', () => {
  let state: InstrumentRunState;

  beforeEach(() => {
    vi.clearAllMocks();
    state = makeState([{ symbol: 'XBTUSD' }]);
  });

  it('emits an update doc for a symbol already in knownSymbols', () => {
    const docs = Array.from(processDayEvents(state, '2019-01-01', [quoteEvent({ bidPrice: 3700, askPrice: 3701 })]));

    expect(docs).toHaveLength(1);
    expect(docs[0]!.action).toBe('update');
  });

  it('carries only source-derived fields in the update (no Tardis lookup)', () => {
    const docs = Array.from(processDayEvents(state, '2019-01-01', [quoteEvent({ bidPrice: 3700, askPrice: 3701 })]));

    expect(docs[0]!.data[0]).toMatchObject({ bidPrice: 3700, askPrice: 3701 });
    expect(getFirstSeedForSymbol).not.toHaveBeenCalled();
  });

  it('assigns a timestamp from the event ms', () => {
    const docs = Array.from(processDayEvents(state, '2019-01-01', [
      quoteEvent({ timestamp: '2019-01-01T12:34:56.789Z', ms: new Date('2019-01-01T12:34:56.789Z').getTime() }),
    ]));

    expect(docs[0]!.data[0]!.timestamp).toBe('2019-01-01T12:34:56.789Z');
  });

  it('increments msgIndex across multiple events', () => {
    const events = [
      quoteEvent({ ms: 1_000, id: 1 }),
      quoteEvent({ ms: 2_000, id: 2 }),
    ];

    const docs = Array.from(processDayEvents(state, '2019-01-01', events));

    expect(docs).toHaveLength(2);
    expect(docs[0]!._id).toBeLessThan(docs[1]!._id);
  });
});

/* ------------------------------------------------------------------ */
/*  processDayEvents — dead symbol                                    */
/* ------------------------------------------------------------------ */

describe('processDayEvents — dead symbol', () => {
  let state: InstrumentRunState;

  beforeEach(() => {
    vi.clearAllMocks();
    state = makeState();
  });

  it('emits no doc when no future Tardis record exists for the symbol', () => {
    vi.mocked(getFirstSeedForSymbol).mockReturnValue(null);

    const docs = Array.from(processDayEvents(state, '2016-12-01', [quoteEvent({ symbol: 'OLDXBT' })]));

    expect(docs).toHaveLength(0);
  });

  it('adds the symbol to deadSymbols when it has no Tardis record', () => {
    vi.mocked(getFirstSeedForSymbol).mockReturnValue(null);

    Array.from(processDayEvents(state, '2016-12-01', [quoteEvent({ symbol: 'OLDXBT' })]));

    expect(state.deadSymbols.has('OLDXBT')).toBe(true);
  });

  it('skips events for a pre-flagged dead symbol without re-querying Tardis', () => {
    state.deadSymbols.add('OLDXBT');

    const docs = Array.from(processDayEvents(state, '2016-12-01', [quoteEvent({ symbol: 'OLDXBT' })]));

    expect(docs).toHaveLength(0);
    expect(getFirstSeedForSymbol).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/*  processDayEvents — same-ms batching                               */
/* ------------------------------------------------------------------ */

describe('processDayEvents — same-ms batching', () => {
  let state: InstrumentRunState;

  beforeEach(() => {
    vi.clearAllMocks();
    state = makeState();
    vi.mocked(getFirstSeedForSymbol).mockReturnValue({ symbol: '' });
  });

  it('emits one doc per symbol even when multiple events share the same ms', () => {
    vi.mocked(getFirstSeedForSymbol).mockImplementation(sym => ({ symbol: sym }));

    const events: InstrumentTaggedEvent[] = [
      quoteEvent({ ms: 1_000, id: 1, symbol: 'XBTUSD', bidPrice: 3600, askPrice: 3601 }),
      quoteEvent({ ms: 1_000, id: 2, symbol: 'ETHUSD', bidPrice: 200,  askPrice: 201  }),
    ];

    const docs = Array.from(processDayEvents(state, '2019-01-01', events));

    expect(docs).toHaveLength(2);
    expect(docs.map(d => d.data[0]!.symbol).sort()).toEqual(['ETHUSD', 'XBTUSD']);
  });

  it('merges same-ms same-symbol events into a single doc', () => {
    state.knownSymbols.add('XBTUSD');

    const events: InstrumentTaggedEvent[] = [
      quoteEvent({ ms: 1_000, id: 1, symbol: 'XBTUSD', bidPrice: 3600, askPrice: undefined as any }),
      quoteEvent({ ms: 1_000, id: 2, symbol: 'XBTUSD', bidPrice: undefined as any, askPrice: 3601 }),
    ];

    const docs = Array.from(processDayEvents(state, '2019-01-01', events));

    expect(docs).toHaveLength(1);
    expect(docs[0]!.data[0]).toMatchObject({ bidPrice: 3600, askPrice: 3601 });
  });
});

/* ------------------------------------------------------------------ */
/*  seedRunState                                                       */
/* ------------------------------------------------------------------ */

describe('seedRunState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('applies an empty partial on cold start with no Tardis seed (pre-2019 data)', async () => {
    const state    = createRunState();
    const mockColl = { findOne: vi.fn() } as unknown as Collection<InstrumentMsg>;

    await seedRunState(mockColl, state, '2016-12-01', '2016-12-01');

    // Table is initialised — snapshot returns an array rather than throwing.
    expect(state.table.snapshot()).toEqual([]);
    expect(state.knownSymbols.size).toBe(0);
  });

  it('does not query MongoDB on cold start (resumeDay === coverageStart)', async () => {
    const state    = createRunState();
    const findOne  = vi.fn();
    const mockColl = { findOne } as unknown as Collection<InstrumentMsg>;

    await seedRunState(mockColl, state, '2019-04-01', '2019-04-01');

    expect(findOne).not.toHaveBeenCalled();
  });

  it('populates knownSymbols from a stored partial on resume', async () => {
    const state  = createRunState();
    const stored = {
      _id:    1,
      action: 'partial' as const,
      keys:   ['symbol'],
      types:  {},
      filter: {},
      data:   [{ symbol: 'XBTUSD', tickSize: 0.5 }],
    };
    const mockColl = {
      findOne: vi.fn().mockResolvedValue(stored),
    } as unknown as Collection<InstrumentMsg>;

    // resumeDay !== coverageStart → resume path
    await seedRunState(mockColl, state, '2019-04-02', '2019-04-01');

    expect(state.knownSymbols.has('XBTUSD')).toBe(true);
  });

  it('on resume, the seeded table accepts subsequent inserts (table is not null)', async () => {
    const state  = createRunState();
    const stored = {
      _id:    1,
      action: 'partial' as const,
      keys:   ['symbol'],
      types:  {},
      filter: {},
      data:   [],
    };
    const mockColl = {
      findOne: vi.fn().mockResolvedValue(stored),
    } as unknown as Collection<InstrumentMsg>;

    await seedRunState(mockColl, state, '2019-04-02', '2019-04-01');

    // Insert should be applied (table is no longer null after the partial).
    state.table.apply({
      table:  BitmexTable.Instrument,
      action: 'insert',
      data:   [{ symbol: 'XBTUSD' }] as any,
    });

    expect(state.table.snapshot().some(i => i.symbol === 'XBTUSD')).toBe(true);
  });

  it('falls back to an empty partial when no stored partial exists (resume path)', async () => {
    const state    = createRunState();
    const mockColl = {
      findOne: vi.fn().mockResolvedValue(null),
    } as unknown as Collection<InstrumentMsg>;

    await seedRunState(mockColl, state, '2019-04-02', '2019-04-01');

    expect(state.table.snapshot()).toEqual([]);
    expect(state.knownSymbols.size).toBe(0);
  });
});
