import { describe, it, expect } from 'vitest';

import { _test_gapSpans as gapSpans } from '../../../src/distillers/instrument/provider';

const HOUR_MS = 3_600_000;

/** An hour starting at a round UTC hour, for readable fixtures. */
const HOUR_START = Date.parse('2022-12-01T05:00:00.000Z');
const HOUR_END   = HOUR_START + HOUR_MS;

const at = (offsetMs: number): { timestamp: string } => ({
  timestamp: new Date(HOUR_START + offsetMs).toISOString(),
});

describe('gapSpans', () => {
  it('reports no gap when documents cover the hour densely', () => {
    // One doc every 30 s from the start to the end — no silence exceeds the threshold.
    const docs  = Array.from({ length: HOUR_MS / 30_000 + 1 }, (_, i) => at(i * 30_000));
    const spans = gapSpans(HOUR_START, HOUR_END, docs);

    expect(spans).toHaveLength(0);
  });

  it('reports the silence between two distant documents', () => {
    // Dense start, a 10-min hole, then dense to the end — leaving exactly one gap.
    const head = Array.from({ length: 21 }, (_, i) => at(i * 30_000));         // 0 .. 600 s
    const tail = Array.from({ length: 100 }, (_, i) => at(1_200_000 + i * 30_000)); // 1200 s .. end
    const spans = gapSpans(HOUR_START, HOUR_END, [...head, ...tail]);

    expect(spans).toHaveLength(1);
    expect(spans[0]!.end - spans[0]!.start).toBe(600_000);
  });

  it('treats a fully empty hour as one full-hour gap', () => {
    const spans = gapSpans(HOUR_START, HOUR_END, []);

    expect(spans).toHaveLength(1);
    expect(spans[0]!.end - spans[0]!.start).toBe(HOUR_MS);
  });

  // The regression: a folded out-of-order reference row carries a timestamp from
  // hours earlier. Left in, it drives `prev` backwards and inflates the next span
  // past a full hour — the cause of a day's gapMin exceeding 1440. It must be
  // ignored, and no span may ever exceed the hour.
  it('ignores out-of-hour rows and never produces a span longer than the hour', () => {
    const folded = { timestamp: new Date(HOUR_START - 7 * HOUR_MS).toISOString() };
    const spans  = gapSpans(HOUR_START, HOUR_END, [folded, at(1_000), at(31_000), at(HOUR_MS - 1_000)]);

    for (const s of spans) expect(s.end - s.start).toBeLessThanOrEqual(HOUR_MS);

    const total = spans.reduce((a, s) => a + (s.end - s.start), 0);

    expect(total).toBeLessThanOrEqual(HOUR_MS);
  });
});
