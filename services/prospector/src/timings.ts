import type { Stretch, StretchTiming } from './types';

/**
 * Where a venue's requests spend their time, stretch by stretch — what the
 * heartbeat reports, so a slow walk says where it is slow without anybody
 * attaching a profiler to find out.
 *
 * **Each stretch is one part of a request's way**, in order:
 *
 * | stretch | from | to |
 * |---|---|---|
 * | `slot` | asked to send | allowed to: the network gate, the venue's limiter and the machine's pool all passed |
 * | `handoff` | sent to a transport worker | its answer back, less the three below — messaging and the worker's own queue |
 * | `firstByte` | the request leaving | the venue's headers |
 * | `body` | the headers | the last byte of the page |
 * | `parse` | the last byte | the page read into keys |
 * | `process` | the page read | the next request of its partition asked for: cataloguing, writing, the cursor |
 *
 * Only `slot` through `parse` hold a slot; `process` runs after it is given back.
 *
 * **Per heartbeat, then forgotten.** Each report covers what happened since the
 * previous one, so a figure says how things are now rather than how they have
 * been since the process started.
 */
export const timed = (venue: string, stretch: Stretch, ms: number): void => {
  let stretches = HELD.get(venue);

  if (! stretches) HELD.set(venue, stretches = new Map());

  let samples = stretches.get(stretch);

  if (! samples) stretches.set(stretch, samples = []);

  if (samples.length < MOST) samples.push(ms);
};

/** Each stretch's average and 90th percentile since the last call, in milliseconds — and a fresh start. */
export const timingsOf = (venue: string): Partial<Record<Stretch, StretchTiming>> => {
  const stretches = HELD.get(venue);

  HELD.delete(venue);

  if (! stretches) return {};

  const report: Partial<Record<Stretch, StretchTiming>> = {};

  for (const stretch of STRETCHES) {
    const samples = stretches.get(stretch);

    if (! samples || samples.length === 0) continue;

    samples.sort((a, b) => a - b);

    report[stretch] = {
      avg: Math.round(samples.reduce((sum, one) => sum + one, 0) / samples.length),
      p90: Math.round(samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.9))]!),
      n:   samples.length,
    };
  }

  return report;
};

// ── Internals ─────────────────────────────────────────────────────────────────

/** In the order a request meets them, which is the order they are reported in. */
const STRETCHES: readonly Stretch[] = ['slot', 'handoff', 'firstByte', 'body', 'parse', 'process'];

/** Samples kept per stretch between reports — far past any heartbeat's worth, and a bound if nobody reads them. */
const MOST = 50_000;

const HELD = new Map<string, Map<Stretch, number[]>>();
