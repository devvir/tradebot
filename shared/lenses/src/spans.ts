import type { LensSpan } from './types';

/**
 * Stretches of time, added to and taken away from.
 *
 * **A lens composes its rules in order, and that is set arithmetic on dates.**
 * Including 2019 to 2021 and then excluding 2020 leaves two spans; collapsing
 * that to one range would hand back a year nobody asked for. So the answer is a
 * list, kept sorted and disjoint at every step, and the two operations below are
 * the whole of what a rule can do to it.
 *
 * **A bound is a month, `yyyymm`.** A day would be a false precision: nobody
 * collects up to the 14th, and a file dated `202006` covers all of June — so a
 * bound of `20200601` reads as *after* that file by plain string comparison and
 * drops the very month it meant to start at. Months make the two ends symmetric
 * and say what anyone actually means.
 *
 * **Which is why the upper bound is widened, not the dates narrowed.** A daily
 * file `20201215` is inside `to: 202012`, and the raw strings say otherwise —
 * `'20201215' > '202012'`, because the shorter sorts first. So the bound becomes
 * `20201299`: every stamp inside the month sorts under it at any grain — a day
 * `20201231`, an hour `2020123123`, a minute `202012312359` — the month's own
 * stamp still sorts below it, and the next month above. `31` was tried first and
 * dropped the last day's hourly and minutely files, which sort past it.
 *
 * The lower bound needs no such help — `202006` already sorts below both
 * `20200601` and `202006`.
 *
 * `null` is open at that end.
 */

/** Add a span, merging anything it touches or overlaps. */
export const union = (spans: readonly LensSpan[], one: LensSpan): LensSpan[] => {
  const kept: LensSpan[] = [];

  let { from, to } = one;

  for (const span of spans) {
    if (disjoint(span, { from, to })) { kept.push(span); continue; }

    from = lower(span.from, from);
    to   = upper(span.to, to);
  }

  kept.push({ from, to });

  return sorted(kept);
};

/**
 * Take a span away, splitting anything it falls inside.
 *
 * The split is the case the whole module exists for: one excluded year in the
 * middle of an included decade leaves the decade in two pieces.
 */
export const without = (spans: readonly LensSpan[], one: LensSpan): LensSpan[] => {
  const kept: LensSpan[] = [];

  for (const span of spans) {
    if (disjoint(span, one)) { kept.push(span); continue; }

    // What survives below the cut, and what survives above it. Either may be
    // empty, and where both are the span is swallowed whole.
    if (below(one.from, span.from)) kept.push({ from: span.from, to: before(one.from!) });
    if (above(one.to, span.to))     kept.push({ from: after(one.to!), to: span.to });
  }

  return sorted(kept);
};

/**
 * Whether a file's date falls inside any of these spans.
 *
 * **Compared as the month it is in**, whatever grain the file is — see above.
 */
export const holds = (spans: readonly LensSpan[], at: string): boolean =>
  spans.some(span => (span.from === null || at >= span.from)
                  && (span.to   === null || at <= lastDay(span.to)));

/** A month bound as a stamp above everything inside it — see above for why `99`. */
export const lastDay = (month: string): string => `${month}99`;

/** Everything, which is where an `include` with no bounds starts. */
export const ALL: LensSpan = { from: null, to: null };

// ── Internals ─────────────────────────────────────────────────────────────────

/** Whether two spans share no day, and so leave each other alone. */
const disjoint = (a: LensSpan, b: LensSpan): boolean =>
  (a.to !== null && b.from !== null && a.to < b.from)
  || (b.to !== null && a.from !== null && b.to < a.from);

/** The earlier left edge, where null is earlier than any date. */
const lower = (a: string | null, b: string | null): string | null =>
  (a === null || b === null ? null : (a < b ? a : b));

/** The later right edge, where null is later than any date. */
const upper = (a: string | null, b: string | null): string | null =>
  (a === null || b === null ? null : (a > b ? a : b));

/** Whether a cut's left edge leaves something of the span below it. */
const below = (cut: string | null, edge: string | null): boolean =>
  cut !== null && (edge === null || edge < cut);

/** Whether a cut's right edge leaves something of the span above it. */
const above = (cut: string | null, edge: string | null): boolean =>
  cut !== null && (edge === null || edge > cut);

const sorted = (spans: LensSpan[]): LensSpan[] =>
  spans.sort((a, b) => (a.from === null ? '' : a.from).localeCompare(b.from === null ? '' : b.from));

/**
 * The month either side of a cut.
 *
 * **Bounds are inclusive**, so excluding `[202001, 202012]` from an open span has
 * to leave `…201912` and `202101…` rather than touching the cut itself.
 */
const before = (at: string): string => shift(at, -1);
const after  = (at: string): string => shift(at, +1);

const shift = (at: string, by: number): string => {
  const month = new Date(Date.UTC(+at.slice(0, 4), +at.slice(4, 6) - 1 + by, 1));

  return `${month.getUTCFullYear()}${String(month.getUTCMonth() + 1).padStart(2, '0')}`;
};
