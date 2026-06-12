import { describe, it, expect, beforeEach } from 'vitest';

import { Walker }                                       from '../../../src/distillers/instrument/walker';
import { createAccumulator, applyMessage }              from '../../../src/distillers/instrument/accumulator';
import { INSTRUMENT_KEYS, INSTRUMENT_TYPES, INSTRUMENT_FILTER } from '../../../src/distillers/instrument/schema';
import { _test_reset as resetRecord }                   from '../../../src/distillers/instrument/record';
import type { Accumulator, InstrumentItem, InstrumentMsg, StreamItem } from '../../../src/distillers/instrument/types';

/** Captures every document the Walker writes, in order, with its real/synth flag. */
class FakeWriter {
  public writes: Array<{ doc: Omit<InstrumentMsg, '_id'>; isReal: boolean }> = [];
  private id = 1;

  async add(doc: Omit<InstrumentMsg, '_id'>, isReal: boolean): Promise<number> {
    this.writes.push({ doc, isReal });

    return this.id++;
  }

  async commit(): Promise<void> {}

  /** Synthetic `update` docs for a symbol, in write order (the conflated/passthrough stream). */
  updates(symbol: string): Array<Partial<InstrumentItem>> {
    return this.writes
      .filter(w => ! w.isReal && w.doc.action === 'update' && w.doc.data[0]?.symbol === symbol)
      .map(w => w.doc.data[0]!);
  }

  /** The seal partials written (one per hour). */
  partials(): Array<Omit<InstrumentMsg, '_id'>> {
    return this.writes.filter(w => w.doc.action === 'partial').map(w => w.doc);
  }
}

const HOUR = '2020-01-01T00';
const hourMs = (offset: number): number => Date.parse(`${HOUR}:00:00.000Z`) + offset;

/** A trading symbol that marks against `.BXBT`, plus the index series itself. */
function seedAcc(): Accumulator {
  const acc = createAccumulator();
  const partial: InstrumentMsg = {
    _id: 0, action: 'partial', timestamp: `${HOUR}:00:00.000Z`,
    keys: INSTRUMENT_KEYS, types: INSTRUMENT_TYPES, filter: INSTRUMENT_FILTER,
    data: [
      { symbol: 'XBTUSD', referenceSymbol: '.BXBT', bidPrice: 100, askPrice: 101, midPrice: 100.5, lastPrice: 100, markPrice: 100, tickSize: 0.5 },
      { symbol: '.BXBT',  referenceSymbol: '.BXBT', lastPrice: 100, markPrice: 100 },
    ],
  };

  applyMessage(acc, partial);

  return acc;
}

function walkerWith(acc: Accumulator, writer: FakeWriter): Walker {
  return new Walker(
    {} as never, {} as never, {} as never,
    writer as never, acc, '', 0,
  );
}

const quote = (offset: number, bidPrice: number, askPrice: number): StreamItem =>
  ({ kind: 'event', ms: hourMs(offset), source: 'quote', row: { symbol: 'XBTUSD', bidPrice, askPrice } as never });

const quoteAt = (hour: string, offset: number, bidPrice: number, askPrice: number): StreamItem =>
  ({ kind: 'event', ms: Date.parse(`${hour}:00:00.000Z`) + offset, source: 'quote', row: { symbol: 'XBTUSD', bidPrice, askPrice } as never });

const run = (w: Walker, hour: string, stream: StreamItem[]): Promise<void> =>
  (w as unknown as { processHour(h: string, s: StreamItem[]): Promise<void> }).processHour(hour, stream);

describe('Walker.processHour — order-book conflation', () => {
  beforeEach(() => resetRecord());

  it('throttles bid/ask to one delta per 5s tick, not one per quote', async () => {
    const writer = new FakeWriter();
    const w = walkerWith(seedAcc(), writer);

    await run(w, HOUR, [
      quote(1000, 100.5, 101.5),   // window 1 [0,5s)
      quote(2000, 101,   102),
      quote(3000, 102,   103),     // last in window 1
      quote(6000, 104,   105),     // window 2 — its arrival flushes window 1 at tick 5s
    ]);

    const updates = writer.updates('XBTUSD');

    // Three changing quotes in window 1 collapse to ONE emit at the 5s tick, carrying the
    // last value. Window 2 has no following tick → not emitted (it rides into the seal).
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ bidPrice: 102, askPrice: 103 });
    expect(updates[0]!.timestamp).toBe(new Date(hourMs(5000)).toISOString());
  });

  it('the seal carries the finest (window-2) value, not the last emitted delta', async () => {
    const writer = new FakeWriter();
    const w = walkerWith(seedAcc(), writer);

    await run(w, HOUR, [quote(1000, 102, 103), quote(6000, 104, 105)]);

    const sealed = writer.partials().at(-1)!.data.find(d => d.symbol === 'XBTUSD')!;

    expect(sealed).toMatchObject({ bidPrice: 104, askPrice: 105 });   // finest, applied immediately
  });

  it('emits nothing for a quote equal to the real baseline (emit-on-change vs reset)', async () => {
    const writer = new FakeWriter();
    const w = walkerWith(seedAcc(), writer);

    // Seeded real bid/ask is 100/101; a synth quote restating it should net to nothing.
    await run(w, HOUR, [quote(1000, 100, 101), quote(6000, 100, 101)]);

    expect(writer.updates('XBTUSD')).toHaveLength(0);
  });
});

describe('Walker.processHour — real data shortcuts conflation', () => {
  beforeEach(() => resetRecord());

  it('passes a real update through immediately and never throttles it', async () => {
    const writer = new FakeWriter();
    const w = walkerWith(seedAcc(), writer);

    const realDoc: InstrumentMsg = {
      _id: 4, action: 'update', timestamp: hourMs(1000) > 0 ? new Date(hourMs(1000)).toISOString() : '',
      keys: INSTRUMENT_KEYS, types: INSTRUMENT_TYPES, filter: INSTRUMENT_FILTER,
      data: [{ symbol: 'XBTUSD', bidPrice: 200, askPrice: 201 }],
    };

    await run(w, HOUR, [{ kind: 'real', ms: hourMs(1000), doc: realDoc }]);

    // Real bid/ask is written whole and immediately (isReal=true), not held for a tick.
    const realWrites = writer.writes.filter(x => x.isReal && x.doc.action === 'update');

    expect(realWrites).toHaveLength(1);
    expect(realWrites[0]!.doc.data[0]).toMatchObject({ bidPrice: 200, askPrice: 201 });
    expect(writer.updates('XBTUSD')).toHaveLength(0);   // nothing went through the Conflator
  });
});

describe('Walker.processHour — gap across an hour boundary', () => {
  beforeEach(() => resetRecord());

  it('keeps the gap open across hours: no re-base, deferred window emits in the next hour', async () => {
    const writer = new FakeWriter();
    const w = walkerWith(seedAcc(), writer);

    // Hour 0: a single quote late in the hour — its window has no following tick, so it is
    // sealed (not emitted) and carried as the finest state.
    await run(w, HOUR, [quote(3_500_000, 150, 151)]);
    expect(writer.updates('XBTUSD')).toHaveLength(0);   // nothing emitted in hour 0

    // Hour 1 continues the same gap (still synth). The carried 150/151 must NOT be wiped by
    // a spurious reset; a new value in hour 1 emits the net change vs the sealed baseline.
    const HOUR1 = '2020-01-01T01';
    const q1: StreamItem = { kind: 'event', ms: Date.parse(`${HOUR1}:00:01.000Z`), source: 'quote',
      row: { symbol: 'XBTUSD', bidPrice: 160, askPrice: 161 } as never };
    const q2: StreamItem = { kind: 'event', ms: Date.parse(`${HOUR1}:00:06.000Z`), source: 'quote',
      row: { symbol: 'XBTUSD', bidPrice: 160, askPrice: 161 } as never };

    await run(w, HOUR1, [q1, q2]);

    const updates = writer.updates('XBTUSD');

    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ bidPrice: 160, askPrice: 161 });   // net change vs sealed 150/151
  });

  it('resume (fresh Walker reseeded from the seal) produces identical hour-N+1 output', async () => {
    const HOUR1 = '2020-01-01T01';
    const h1Start = Date.parse(`${HOUR1}:00:00.000Z`);
    const streamH0 = [quote(1000, 110, 111), quote(6000, 112, 113), quote(3_500_000, 120, 121)];
    const streamH1 = [quoteAt(HOUR1, 1000, 130, 131), quoteAt(HOUR1, 6000, 132, 133)];

    // Continuous run: one Walker walks H0 (gap) then H1, carrying inGap=true across.
    const cont = new FakeWriter();
    const wc = walkerWith(seedAcc(), cont);
    await run(wc, HOUR, streamH0);
    const sealH0 = cont.partials().at(-1)!;          // H0's seal — the resume anchor
    await run(wc, HOUR1, streamH1);
    const continuousH1 = cont.updates('XBTUSD').filter(d => (d.timestamp as string) >= `${HOUR1}:00:00.000Z`);

    // Resume run: a FRESH Walker (inGap=false) whose accumulator is rebuilt from H0's
    // seal partial, replaying H1 alone — the crash-recovery path.
    const accResume = createAccumulator();
    applyMessage(accResume, sealH0 as InstrumentMsg);
    const res = new FakeWriter();
    const wr = walkerWith(accResume, res);
    await run(wr, HOUR1, streamH1);
    const resumeH1 = res.updates('XBTUSD');

    // Byte-identical conflated/passthrough stream — the determinism guarantee.
    expect(resumeH1).toEqual(continuousH1);
    expect(resumeH1.length).toBeGreaterThan(0);                       // and it actually emitted something
    expect(h1Start).toBe(Date.parse('2020-01-01T01:00:00.000Z'));     // (sanity on the hour anchor)
  });
});
