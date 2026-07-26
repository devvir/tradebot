/**
 * The replay clock — the single source of truth for "what time is it" in replay.
 *
 * A module-level `number | null`: the epoch-ms timestamp of the last message
 * emitted onto the shared stream. Data-driven and forward-only — it advances only
 * as messages flow, and freezes (holds its value) when nothing is subscribed.
 *
 *   set(ms)    — jump to any instant (control plane: start time / seek).
 *   update(ms) — forward-only advance, called once per emitted message.
 *   fetch()    — current replay time, or null before anything is set.
 *
 * Read by the REST surface as the "now" ceiling, and by the reader to position a
 * cold-activated table.
 */

let clockMs: number | null = null;

export const set = (ms: number): void => {
  clockMs = ms;
};

export const update = (ms: number): void => {
  if (clockMs === null || ms > clockMs) clockMs = ms;
};

export const fetch = (): number | null =>
  clockMs;

// ── Test-only ─────────────────────────────────────────────────────────────────

export const _test_reset = (): void => { clockMs = null; };
