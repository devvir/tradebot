import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MongoClient, Db } from 'mongodb';
import { startOfDayMongoId, makeMongoId } from '@tradebot/utils';

import { Reader, _test_place as place } from '../../../src/distillers/instrument/reader';

const { mongoPort } = JSON.parse(readFileSync(resolve(__dirname, '../../.ports.json'), 'utf8'));
const DB_NAME  = 'test_reader';
const mongoUrl = `mongodb://root:root@localhost:${mongoPort}/${DB_NAME}?authSource=admin`;

type Row = { _id: number; timestamp: string; action?: string; data?: { symbol?: string }[] };

/** A fresh, empty table state — the shape `place` mutates. */
const state = () => ({ cursor: 0, done: false, frontier: '', buckets: new Map<string, Row[]>() });

/** A source row. */
const row = (id: number): Row => ({ _id: id, timestamp: '' });

/** Bucket keys → the `_id`s they hold, for compact assertions. */
const layout = (st: ReturnType<typeof state>): [string, number[]][] =>
  [...st.buckets.entries()].map(([k, rows]) => [k, rows.map(r => r._id)]);

/* eslint-disable @typescript-eslint/no-explicit-any */
const put = (st: ReturnType<typeof state>, table: string, key: string, r: Row, servedThrough: string) =>
  place(st as any, table, key, r as any, servedThrough);

describe('reader — bucketing before serving has begun (servedThrough empty)', () => {
  it('buckets every row by its own hour, regardless of read order', () => {
    const st = state();

    // The lowest-`_id` row is timestamped late (T03); an earlier hour (T01) is
    // read after it. Nothing has been served, so each lands in its own bucket.
    put(st, 'instrument', '2020-01-01T03', row(1), '');
    put(st, 'instrument', '2020-01-01T01', row(2), '');
    put(st, 'instrument', '2020-01-01T03', row(3), '');

    expect(layout(st)).toEqual([
      ['2020-01-01T03', [1, 3]],
      ['2020-01-01T01', [2]],
    ]);
  });
});

describe('reader — bucketing after the served frontier', () => {
  it('opens or joins the bucket for any hour still ahead of the frontier', () => {
    const st = state();

    put(st, 'instrument', '2020-01-01T06', row(1), '2020-01-01T05');
    put(st, 'instrument', '2020-01-01T08', row(2), '2020-01-01T05');

    expect(layout(st)).toEqual([
      ['2020-01-01T06', [1]],
      ['2020-01-01T08', [2]],
    ]);
  });

  it('drops an instrument row whose hour has already been served', () => {
    const st = state();

    put(st, 'instrument', '2020-01-01T06', row(1), '2020-01-01T05');   // ahead — kept
    put(st, 'instrument', '2020-01-01T04', row(2), '2020-01-01T05');   // served — dropped

    expect(layout(st)).toEqual([['2020-01-01T06', [1]]]);
  });
});

describe('reader — proxy tables are silently dropped past the frontier', () => {
  it('drops a stale proxy row without warning and without classifying it', () => {
    const st = state();

    // `tick` is all-referential and carries a top-level `.`-symbol; it must not
    // be folded or warned — just dropped, as a stale synthesis input.
    put(st, 'tick', '2020-01-01T09', { _id: 1, timestamp: '', symbol: '.BXBT' } as Row, '2020-01-01T11');

    expect(layout(st)).toEqual([]);
  });

  it('buckets a proxy row that is still ahead of the frontier', () => {
    const st = state();

    put(st, 'tick', '2020-01-01T12', { _id: 1, timestamp: '', symbol: '.BXBT' } as Row, '2020-01-01T11');

    expect(layout(st)).toEqual([['2020-01-01T12', [1]]]);
  });
});

describe('reader — determinism', () => {
  it('placement depends only on read order, not consumer speed', () => {
    const run = () => {
      const st = state();

      for (const [id, key] of [
        [1, '2020-01-01T00'],
        [2, '2020-01-01T02'],
        [3, '2020-01-01T00'],
        [4, '2020-01-01T01'],
      ] as [number, string][]) put(st, 'instrument', key, row(id), '');

      return layout(st);
    };

    expect(run()).toEqual(run());
    expect(run()).toEqual([
      ['2020-01-01T00', [1, 3]],
      ['2020-01-01T02', [2]],
      ['2020-01-01T01', [4]],
    ]);
  });
});

describe('reader — symbol-major (clustered) proxy reading', () => {
  let client: MongoClient;
  let db:     Db;

  beforeAll(async () => {
    client = new MongoClient(mongoUrl);
    await client.connect();
    db = client.db(DB_NAME);
  });

  afterAll(async () => {
    await client?.close();
  });

  beforeEach(async () => {
    await db.collection('compositeIndex').deleteMany({});
  });

  /**
   * BitMEX/scribe store the proxy tables symbol-major: each symbol's whole "day"
   * (here hours 00–03) is one contiguous `_id` run, runs concatenated A, B, Z.
   * Symbol Z's run sorts last, so the Reader reaches it only after serving has
   * advanced past the early hours. Every hour 00–03 has a real row for all three
   * symbols, so every served hour must carry all three — a last-read cluster's
   * early-hour rows must be served, not dropped as "already past the frontier".
   */
  it('serves a last-read symbol cluster in the early hours it covers', async () => {
    const DAY  = '2020-01-01';
    const rows: Record<string, unknown>[] = [];
    let   pos  = 1;

    for (const symbol of ['A', 'B', 'Z']) {
      for (const h of [0, 1, 2, 3]) {
        rows.push({
          _id:         makeMongoId(DAY, pos++, 0),
          timestamp:   `${DAY}T0${h}:00:00.000Z`,
          symbol,
          indexSymbol: symbol,   // compositeIndex clusters by indexSymbol
          reference:   'BMI',
          lastPrice:   '100',
        });
      }
    }

    await db.collection('compositeIndex').insertMany(rows);

    // Tiny dimensions exercise the same read loop: 4-row batches, 2-bucket warm.
    const reader = new Reader(db, startOfDayMongoId(DAY), '', 4, 2);

    const symbolsByHour = new Map<string, string[]>();

    for (let served = await reader.pop(); served !== null; served = await reader.pop()) {
      symbolsByHour.set(
        served.hour,
        (served.buckets.compositeIndex as unknown as { symbol: string }[]).map(r => r.symbol).sort(),
      );
    }

    for (const h of ['00', '01', '02', '03']) {
      expect(symbolsByHour.get(`${DAY}T${h}`)).toEqual(['A', 'B', 'Z']);
    }
  });

  /**
   * The read budget is split across partitions, so a clustered table never pulls
   * every cluster's whole day at once (the OOM path). Three clusters of 8 hours ×
   * 10 rows each (240 rows): with a tiny budget the buffer must stay a small
   * fraction of the total throughout, while still serving every hour complete with
   * all three clusters — nothing dropped.
   */
  it('scales the fetch by partition count so a clustered table is never read whole', async () => {
    const DAY  = '2020-03-01';
    const rows: Record<string, unknown>[] = [];
    let   pos  = 1;

    for (const sym of ['A', 'B', 'Z']) {
      for (let h = 0; h < 8; h++) {
        for (let m = 0; m < 10; m++) {
          rows.push({
            _id:         makeMongoId(DAY, pos++, 0),
            timestamp:   `${DAY}T0${h}:${String(m).padStart(2, '0')}:00.000Z`,
            symbol:      sym,
            indexSymbol: sym,
            reference:   'BMI',
            lastPrice:   '100',
          });
        }
      }
    }

    await db.collection('compositeIndex').insertMany(rows);

    // budget 6 over 3 partitions, floor 2 → 2 rows per fetch; buffer 2 hours.
    const reader        = new Reader(db, startOfDayMongoId(DAY), '', 6, 2, 2);
    const symbolsByHour = new Map<string, Set<string>>();
    let   peak          = 0;

    for (let s = await reader.pop(); s !== null; s = await reader.pop()) {
      peak = Math.max(peak, reader._test_bufferedRows());
      symbolsByHour.set(
        s.hour,
        new Set((s.buckets.compositeIndex as unknown as { symbol: string }[]).map(r => r.symbol)),
      );
    }

    // Never holds anywhere near the whole table (240 rows) — read-whole would sit ~210.
    expect(peak).toBeLessThan(rows.length / 2);

    // And loses nothing: every hour carries all three clusters.
    for (let h = 0; h < 8; h++) {
      expect([...symbolsByHour.get(`${DAY}T0${h}`)!].sort()).toEqual(['A', 'B', 'Z']);
    }
  });

  /**
   * Completeness under uneven density. A dense cluster needs many small fetches to
   * advance one hour; a sparse one races ahead. The horizon gates BOTH, and the warm
   * loop re-fetches the lagging (dense) cluster as many times as needed every pop —
   * so a sparse cluster reaching far ahead can never cause the dense one's later
   * hours to be served before it was read. Every hour must carry both.
   */
  it('keeps a dense cluster complete while a sparse one races ahead', async () => {
    const DAY  = '2020-04-01';
    const rows: Record<string, unknown>[] = [];
    let   pos  = 1;

    // Symbol-major order (D before S): D dense (30/hour), S sparse (1/hour), both 6 hours.
    for (let h = 0; h < 6; h++) {
      for (let m = 0; m < 30; m++) {
        rows.push({ _id: makeMongoId(DAY, pos++, 0), timestamp: `${DAY}T0${h}:${String(m).padStart(2, '0')}:00.000Z`,
          symbol: 'D', indexSymbol: 'D', reference: 'BMI', lastPrice: '1' });
      }
    }

    for (let h = 0; h < 6; h++) {
      rows.push({ _id: makeMongoId(DAY, pos++, 0), timestamp: `${DAY}T0${h}:00:00.000Z`,
        symbol: 'S', indexSymbol: 'S', reference: 'BMI', lastPrice: '1' });
    }

    await db.collection('compositeIndex').insertMany(rows);

    // Tiny budget/floor so the dense cluster genuinely needs many fetches per hour.
    const reader        = new Reader(db, startOfDayMongoId(DAY), '', 4, 2, 2);
    const symbolsByHour = new Map<string, Set<string>>();

    for (let s = await reader.pop(); s !== null; s = await reader.pop()) {
      symbolsByHour.set(
        s.hour,
        new Set((s.buckets.compositeIndex as unknown as { symbol: string }[]).map(r => r.symbol)),
      );
    }

    for (let h = 0; h < 6; h++) {
      expect([...symbolsByHour.get(`${DAY}T0${h}`)!].sort()).toEqual(['D', 'S']);
    }
  });
});
