import type { InstrumentItem, ConflatorEmit } from './types';

/**
 * Order-book fields conflated to the 5s grid (a 5s sample of the live book, like
 * BitMEX). Every other synthetic trading field passes through at its own cadence
 * (lastPrice per-trade, the 24h block per-minute, funding/settlement as they occur).
 * Reference series are conflated whole, separately — they carry no order book.
 */
export const CONFLATED_FIELDS: ReadonlySet<string> = new Set(['bidPrice', 'askPrice', 'midPrice']);

/** Split a trading symbol's delta into its conflated (order-book) and passthrough parts. */
export function splitConflated(fields: Partial<InstrumentItem>): {
  conflated:   Partial<InstrumentItem>;
  passthrough: Partial<InstrumentItem>;
} {
  const conflated:   Record<string, unknown> = {};
  const passthrough: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(fields)) {
    if (CONFLATED_FIELDS.has(key)) conflated[key] = value;
    else                          passthrough[key] = value;
  }

  return { conflated, passthrough };
}

/**
 * Throttles synthesized deltas to a fixed grid (≈5s), reproducing BitMEX's own
 * emit-on-change cadence: a value publishes a delta only when it changes since the
 * last emission. Used for the conflated fields — order-book bid/ask and reference
 * index values — while non-conflated fields (lastPrice, the 24h block, funding) pass
 * through untouched. See `docs/BitMEX/INSTRUMENT.md`.
 *
 * The Walker drives it: `accept` every synthesized conflated field as events flow,
 * `flush` on each tick boundary to emit the net change since the last emission, and
 * `seal` at the hour boundary (the seal partial already carries the state, so the
 * final window is reconciled, not emitted). `reset` re-bases from the accumulator at
 * the start of each gap so synth diffs against the latest real values.
 *
 * It is **delta-aware**, not a plain merge: a field that moves and returns within a
 * window (`0→1→0`) nets to no change and is dropped; successive deltas collapse to
 * their final value; a window with no net change emits nothing.
 */
export class Conflator {
  /** Last-emitted state per symbol — the diff baseline. */
  private readonly baseline = new Map<string, Record<string, unknown>>();

  /** Fields accumulated in the open window, per symbol — cleared each flush/seal. */
  private readonly working = new Map<string, Record<string, unknown>>();

  /**
   * Re-base the diff baseline from a full accumulator snapshot and clear the open
   * window. Called at the start of each gap (the real→gap transition) so a gap's
   * synth diffs against the latest real values, and any stale window left from a
   * previous gap is discarded. The snapshot is the accumulator's current real state.
   */
  reset(snapshot: Iterable<Partial<InstrumentItem>>): void {
    this.baseline.clear();
    this.working.clear();

    for (const item of snapshot) {
      if (item.symbol) this.baseline.set(item.symbol, { ...item });
    }
  }

  /** Accumulate one synthesized conflated delta into the open window. */
  accept(symbol: string, fields: Partial<InstrumentItem>): void {
    const win = this.working.get(symbol) ?? {};

    Object.assign(win, fields);
    this.working.set(symbol, win);
  }

  /**
   * Close the window: per symbol, emit only the fields that net-changed vs the
   * baseline, advance the baseline, and clear the window. Empty when nothing changed.
   */
  flush(): ConflatorEmit[] {
    const emits = this.diff();

    this.working.clear();

    return emits;
  }

  /**
   * Advance the baseline from the open window **without emitting** — for the hour
   * boundary, where the seal partial already carries the accumulated state.
   */
  seal(): void {
    this.diff();
    this.working.clear();
  }

  /* ---------------------------------------------------------------- */

  /** Net-changed fields per symbol; advances the baseline as a side effect. */
  private diff(): ConflatorEmit[] {
    const emits: ConflatorEmit[] = [];

    for (const [symbol, win] of this.working) {
      const base   = this.baseline.get(symbol) ?? {};
      const fields: Record<string, unknown> = {};

      for (const key of Object.keys(win)) {
        if (win[key] !== base[key]) fields[key] = win[key];
      }

      if (Object.keys(fields).length > 0) {
        emits.push({ symbol, fields: fields as Partial<InstrumentItem> });
        this.baseline.set(symbol, { ...base, ...win });
      }
    }

    return emits;
  }
}
