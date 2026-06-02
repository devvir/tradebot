/**
 * Staging byte gate — the single backpressure choke point between the
 * processing side (infer / assemble) and the writing side (dispatch / flush).
 *
 *   - infer / assemble call `await admit(item.size)` *before* pushing into the
 *     writer queue. If `staged + bytes > cap` the call awaits a release.
 *   - flush calls `release(bytes)` once a batch is spliced out to be POSTed.
 *
 * `staged` therefore equals the byte size of everything processed but not yet
 * handed to an HTTP request — (writer queue + per-table batches). Bounding it
 * in bytes (not item count) keeps the staged memory predictable no matter how
 * big each message is, and a blocked `admit` propagates backpressure all the
 * way back to the vault readers.
 *
 * This is "ready to send", NOT "in flight": once a batch leaves here it's
 * counted against the flusher's in-flight *request* cap instead.
 */

let cap    = Number.POSITIVE_INFINITY;
let staged = 0;

let waiters: Array<() => void> = [];

// ── Public API ────────────────────────────────────────────────────────────────

export const initStaging = (capBytes: number): void => {
  cap = capBytes;
};

export const admit = async (bytes: number): Promise<void> => {
  while (staged + bytes > cap) {
    await new Promise<void>(resolve => waiters.push(resolve));
  }

  staged += bytes;
};

export const release = (bytes: number): void => {
  staged -= bytes;

  if (staged < 0) staged = 0;

  if (waiters.length === 0) return;

  const w = waiters;

  waiters = [];
  w.forEach(r => r());
};

export const stagedBytes = (): number => staged;

// ── Test-only exports ─────────────────────────────────────────────────────────

export const _test_reset = (): void => {
  cap     = Number.POSITIVE_INFINITY;
  staged  = 0;
  waiters = [];
};
