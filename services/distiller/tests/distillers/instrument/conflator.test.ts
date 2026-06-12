import { describe, it, expect } from 'vitest';

import { Conflator, splitConflated } from '../../../src/distillers/instrument/conflator';

/** Compact `{symbol: fields}` view of a flush, for assertions. */
const emit = (t: Conflator): Record<string, Record<string, unknown>> =>
  Object.fromEntries(t.flush().map(e => [e.symbol, e.fields]));

describe('Conflator — delta-aware aggregation on a tick', () => {
  it('emits the accumulated fields on the tick', () => {
    const t = new Conflator();

    t.accept('.A', { lastPrice: 1 });
    t.accept('.B', { lastPrice: 2 });

    expect(emit(t)).toEqual({ '.A': { lastPrice: 1 }, '.B': { lastPrice: 2 } });
  });

  it('collapses successive deltas of one symbol to its final value', () => {
    const t = new Conflator();

    t.accept('.A', { lastPrice: 1 });
    t.accept('.B', { lastPrice: 2 });
    t.accept('.A', { lastPrice: 3 });

    expect(emit(t)).toEqual({ '.A': { lastPrice: 3 }, '.B': { lastPrice: 2 } });
  });

  it('emits nothing when the window nets back to the baseline (0→1→0)', () => {
    const t = new Conflator();

    t.reset([{ symbol: '.A', lastPrice: 0 }, { symbol: '.B', lastPrice: 0 }]);

    t.accept('.A', { lastPrice: 1 });
    t.accept('.B', { lastPrice: 1 });
    t.accept('.A', { lastPrice: 0 });
    t.accept('.B', { lastPrice: 0 });

    expect(emit(t)).toEqual({});
  });

  it('emits only the fields that net-changed vs the baseline', () => {
    const t = new Conflator();

    t.reset([{ symbol: '.A', lastPrice: 10, markPrice: 10 }]);
    t.accept('.A', { lastPrice: 11, markPrice: 10 });   // markPrice unchanged

    expect(emit(t)).toEqual({ '.A': { lastPrice: 11 } });
  });
});

describe('Conflator — across ticks and seal', () => {
  it('a symbol unchanged since the last emission is silent on the next tick', () => {
    const t = new Conflator();

    t.accept('.A', { lastPrice: 1 });
    expect(emit(t)).toEqual({ '.A': { lastPrice: 1 } });   // first tick

    // No accept for .A this window → nothing to emit.
    expect(emit(t)).toEqual({});

    t.accept('.A', { lastPrice: 1 });                       // same value re-derived
    expect(emit(t)).toEqual({});                            // still no net change

    t.accept('.A', { lastPrice: 2 });
    expect(emit(t)).toEqual({ '.A': { lastPrice: 2 } });
  });

  it('seal advances the baseline without emitting (the partial carries it)', () => {
    const t = new Conflator();

    t.accept('.A', { lastPrice: 5 });
    t.seal();                                               // no emit; baseline ← 5

    t.accept('.A', { lastPrice: 5 });
    expect(emit(t)).toEqual({});                            // unchanged vs sealed baseline

    t.accept('.A', { lastPrice: 6 });
    expect(emit(t)).toEqual({ '.A': { lastPrice: 6 } });
  });
});

describe('Conflator — reset re-bases from the snapshot and clears the open window', () => {
  it('discards a pending synth window and re-bases, so real values win', () => {
    const t = new Conflator();

    // Gap fill synthesizes an older value; then a new gap starts and re-bases from the
    // latest real state (the Walker calls reset on the real→gap transition).
    t.accept('.A', { lastPrice: 100 });                     // pending synth in the window
    t.reset([{ symbol: '.A', lastPrice: 105 }]);            // re-base from real value 105

    // The pending 100 is gone; the open window is empty, baseline is 105 → nothing to emit.
    expect(emit(t)).toEqual({});

    // A genuinely new synth still emits the net change vs the re-based value.
    t.accept('.A', { lastPrice: 110 });
    expect(emit(t)).toEqual({ '.A': { lastPrice: 110 } });
  });

  it('an unchanged synth after reset emits nothing (diffs against the real base)', () => {
    const t = new Conflator();

    t.reset([{ symbol: 'XBTUSD', bidPrice: 100, askPrice: 101 }]);
    t.accept('XBTUSD', { bidPrice: 100, askPrice: 101 });   // same as the real base

    expect(emit(t)).toEqual({});
  });
});

describe('splitConflated', () => {
  it('separates order-book fields from everything else', () => {
    const { conflated, passthrough } = splitConflated({
      bidPrice: 100, askPrice: 101, midPrice: 100.5,
      lastPrice: 99, volume24h: 5, markPrice: 102,
    });

    expect(conflated).toEqual({ bidPrice: 100, askPrice: 101, midPrice: 100.5 });
    expect(passthrough).toEqual({ lastPrice: 99, volume24h: 5, markPrice: 102 });
  });

  it('yields empty parts when a side is absent', () => {
    expect(splitConflated({ lastPrice: 99 })).toEqual({ conflated: {}, passthrough: { lastPrice: 99 } });
    expect(splitConflated({ bidPrice: 1 })).toEqual({ conflated: { bidPrice: 1 }, passthrough: {} });
  });
});
