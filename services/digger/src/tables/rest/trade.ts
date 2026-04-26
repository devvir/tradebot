import type { TableHandler } from '../handler';
import { makeEmptyPartial, timestampFromField } from '../handler';
import type { MongoDoc, TakeResult } from '../../types';

/**
 * trade — REST-origin.
 *
 * Sweep reconstruction: the live BitMEX WS groups consecutive trades that
 * share `timestamp + symbol` into a single insert message. We reconstruct that
 * grouping here so replay consumers see the same message boundaries.
 *
 * KNOWN EDGE CASES (acceptable):
 *   - Two distinct sweeps that share `timestamp + symbol` (~1% of multi-level
 *     sweeps) are indistinguishable from REST data and get merged into one insert.
 *   - A sweep that straddles two buffer fills emits as two smaller inserts.
 *     Mitigated in practice by the 5k low-watermark; rare enough to ignore.
 */
export const tradeHandler: TableHandler = {
  collection: 'trade',
  origin:     'rest',

  partial: makeEmptyPartial(
    'trade',
    /* keys */        [],
    /* types */       {
      timestamp:       'timestamp',
      symbol:          'symbol',
      side:            'symbol',
      size:            'long',
      price:           'float',
      tickDirection:   'symbol',
      trdMatchID:      'guid',
      grossValue:      'long',
      homeNotional:    'float',
      foreignNotional: 'float',
      trdType:         'symbol',
      pool:            'symbol',
    },
    /* foreignKeys */ { symbol: 'instrument' },
    /* attributes */  { timestamp: 'sorted', symbol: 'grouped' },
    /* filter */      {},
  ),

  getTimestamp: timestampFromField,

  take(docs: MongoDoc[]): TakeResult | null {
    if (docs.length === 0) return null;

    const consumed = countSweep(docs);
    const data     = docs.slice(0, consumed).map(stripId);
    const ts       = docs[0].timestamp as string;

    return {
      messages: [{
        table:     'trade',
        action:    'insert',
        timestamp: new Date(ts).getTime(),
        payload:   { table: 'trade', action: 'insert', data },
      }],
      consumed,
    };
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Count consecutive head docs that belong to the same sweep (same timestamp+symbol). */
const countSweep = (docs: MongoDoc[]): number => {
  const ts  = docs[0].timestamp as string;
  const sym = docs[0].symbol    as string;

  let n = 1;

  while (
    n < docs.length &&
    (docs[n].timestamp as string) === ts &&
    (docs[n].symbol    as string) === sym
  ) {
    n++;
  }

  return n;
};

const stripId = ({ _id: _, ...rest }: MongoDoc): Record<string, unknown> => rest;
