/**
 * The replay clock — the single source of truth for "what time is it" in replay.
 *
 * Module-level singleton. Three operations:
 *
 *   set(ms)    — jump to any point in time (used on seek/resubscribe).
 *                Buffers must be discarded by the caller; this just moves the value.
 *   update(ms) — forward-only advance, called once per published message.
 *   fetch()    — current replay time, or null when nothing has been published yet.
 *
 * Read by the WS streaming engine to keep all tables in chronological order, and
 * by the REST routes to interpret "now" for queries that don't pin a timestamp.
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
