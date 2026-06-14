import { describe, it, expect } from 'vitest';
import { makeMongoId, startOfDayMongoId } from '@tradebot/utils';
import { estimateRangeCount } from '../../../src/tools/db/utils/count';
import type { DateRange } from '../../../src/tools/db/types';

// ── In-memory Mongo fake ───────────────────────────────────────────────────────
// Implements only the surface estimateRangeCount touches: estimatedDocumentCount,
// countDocuments({_id:{$gte,$lt}}), and the find().project().sort().limit().next()
// bracket chain. Each collection is just a sorted list of numeric `_id`s, with an
// optional `estimated` override so we can exercise the large-collection path
// without materialising a million docs.

type IdRange = { $gte?: number; $lt?: number };

function matches(id: number, range: IdRange | undefined): boolean {
  if (! range) return true;

  if (range.$gte !== undefined && id < range.$gte) return false;
  if (range.$lt  !== undefined && id >= range.$lt) return false;

  return true;
}

class FakeCollection {
  private ids: number[];
  private estimated: number | undefined;

  constructor(ids: number[], estimated?: number) {
    this.ids       = [...ids].sort((a, b) => a - b);
    this.estimated = estimated;
  }

  async estimatedDocumentCount(): Promise<number> {
    return this.estimated ?? this.ids.length;
  }

  async countDocuments(filter: { _id?: IdRange } = {}): Promise<number> {
    return this.ids.filter(id => matches(id, filter._id)).length;
  }

  find(filter: { _id?: IdRange } = {}) {
    const matched = this.ids.filter(id => matches(id, filter._id));
    let dir = 1;

    const cursor = {
      project: () => cursor,
      sort:    (s: { _id: number }) => { dir = s._id; return cursor; },
      limit:   () => cursor,
      async next(): Promise<{ _id: number } | null> {
        if (matched.length === 0) return null;

        const id = dir >= 0 ? matched[0] : matched[matched.length - 1];

        return { _id: id };
      },
    };

    return cursor;
  }
}

class FakeDb {
  private collections: Map<string, FakeCollection>;

  constructor(collections: Record<string, FakeCollection>) {
    this.collections = new Map(Object.entries(collections));
  }

  collection(name: string): FakeCollection {
    const c = this.collections.get(name);

    if (! c) throw new Error(`unknown collection '${name}'`);

    return c;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Dense run of `_id`s for one day, positions `from`..`to` (1-based, inclusive). */
function dayIds(ymd: string, from: number, to: number): number[] {
  const ids: number[] = [];

  for (let pos = from; pos <= to; pos++) ids.push(makeMongoId(ymd, pos));

  return ids;
}

/** A whole-day, whole-month-style range filter for the given dashless day. */
function dayRange(ymd: string): DateRange {
  const next = nextYmd(ymd);

  return {
    label:   ymd,
    key:     ymd,
    startId: startOfDayMongoId(ymd),
    endId:   startOfDayMongoId(next),
  };
}

function spanRange(startYmd: string, endExclusiveYmd: string): DateRange {
  return {
    label:   `${startYmd}-${endExclusiveYmd}`,
    key:     `${startYmd}${endExclusiveYmd}`,
    startId: startOfDayMongoId(startYmd),
    endId:   startOfDayMongoId(endExclusiveYmd),
  };
}

function nextYmd(ymd: string): string {
  const y = parseInt(ymd.slice(0, 4), 10);
  const m = parseInt(ymd.slice(4, 6), 10);
  const d = parseInt(ymd.slice(6, 8), 10);
  const n = new Date(Date.UTC(y, m - 1, d + 1));

  return `${n.getUTCFullYear()}${String(n.getUTCMonth() + 1).padStart(2, '0')}${String(n.getUTCDate()).padStart(2, '0')}`;
}

const BIG = 2_000_000;  // ≥ BIG_COLLECTION_THRESHOLD, forces the fast (bracket) path

describe('estimateRangeCount', () => {
  it('returns 0 for an empty collection', async () => {
    const db = new FakeDb({ instrument: new FakeCollection([]) });

    expect(await estimateRangeCount(db as never, 'instrument', dayRange('20260101'))).toBe(0);
  });

  it('counts a small collection exactly via countDocuments', async () => {
    // Below threshold → straight countDocuments over the range.
    const db = new FakeDb({ instrument: new FakeCollection(dayIds('20260101', 1, 50)) });

    expect(await estimateRangeCount(db as never, 'instrument', dayRange('20260101'))).toBe(50);
  });

  it('counts a small collection bounded to the range, ignoring out-of-range docs', async () => {
    const ids = [...dayIds('20260101', 1, 30), ...dayIds('20260102', 1, 7)];
    const db  = new FakeDb({ instrument: new FakeCollection(ids) });

    expect(await estimateRangeCount(db as never, 'instrument', dayRange('20260101'))).toBe(30);
  });

  // ── Large path: dense slot packing ───────────────────────────────────────────

  it('counts a full day on the large path from the highest position', async () => {
    const db = new FakeDb({ instrument: new FakeCollection(dayIds('20260101', 1, 1000), BIG) });

    expect(await estimateRangeCount(db as never, 'instrument', dayRange('20260101'))).toBe(1000);
  });

  it('sums dense per-day counts across a multi-day span', async () => {
    const ids = [
      ...dayIds('20260101', 1, 1000),
      ...dayIds('20260102', 1,  400),
      ...dayIds('20260103', 1,  250),
    ];
    const db = new FakeDb({ instrument: new FakeCollection(ids, BIG) });

    expect(await estimateRangeCount(db as never, 'instrument', spanRange('20260101', '20260104'))).toBe(1650);
  });

  it('skips empty interior days (no docs → 0 for that day)', async () => {
    const ids = [
      ...dayIds('20260101', 1, 500),
      // 20260102 entirely absent
      ...dayIds('20260103', 1, 300),
    ];
    const db = new FakeDb({ instrument: new FakeCollection(ids, BIG) });

    expect(await estimateRangeCount(db as never, 'instrument', spanRange('20260101', '20260104'))).toBe(800);
  });

  // ── Large path: head-first purge (the new behaviour) ─────────────────────────

  it('reports the remaining span after a head-first purge has eaten the low slots', async () => {
    // Day originally held positions 1..1000; an _id-asc purge removed 1..600, so
    // positions 601..1000 remain → 400 docs. The old highest-only count would
    // have wrongly reported 1000.
    const db = new FakeDb({ instrument: new FakeCollection(dayIds('20260101', 601, 1000), BIG) });

    expect(await estimateRangeCount(db as never, 'instrument', dayRange('20260101'))).toBe(400);
  });

  it('reports a single surviving doc after a near-complete purge', async () => {
    const db = new FakeDb({ instrument: new FakeCollection(dayIds('20260101', 1000, 1000), BIG) });

    expect(await estimateRangeCount(db as never, 'instrument', dayRange('20260101'))).toBe(1);
  });

  // ── exact override ────────────────────────────────────────────────────────────

  it('with exact:true scans countDocuments even on a large collection', async () => {
    // Sparse/purged day: positions 601..1000 → 400 actual docs. The exact path
    // counts them directly rather than decoding positions.
    const db = new FakeDb({ instrument: new FakeCollection(dayIds('20260101', 601, 1000), BIG) });

    expect(await estimateRangeCount(db as never, 'instrument', dayRange('20260101'), { exact: true })).toBe(400);
  });

  // ── Bin scaling ───────────────────────────────────────────────────────────────

  it('scales a dense source-row span down to an estimated bin count for bin tables', async () => {
    // Bin _ids carry the source trade's position, so they are sparse within a
    // day: here two bin docs at source positions 1 and 101 → span 101, while the
    // exact bin count for the day is 2. The sampled ratio (2/101) scales the
    // dense span back to the real bin count.
    const db = new FakeDb({
      tradeBin1m: new FakeCollection([makeMongoId('20260101', 1), makeMongoId('20260101', 101)], BIG),
    });

    expect(await estimateRangeCount(db as never, 'tradeBin1m', dayRange('20260101'))).toBe(2);
  });
});
