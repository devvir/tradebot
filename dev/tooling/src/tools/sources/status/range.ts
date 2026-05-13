import { nextDay } from '../ranges';

/**
 * A maximal date-contiguous span where every per-day attribute (computed by
 * the caller) is identical across the real days inside it. Filled days do
 * not contribute attributes and never split a range — they're treated as
 * already-resolved gaps.
 */
export interface Range<A> {
  start: string;          // YYYYMMDD — first real day in the range
  end:   string;          // YYYYMMDD — last real day in the range
  attr:  A;               // attribute shared by every real day inside
}

export interface RangeOptions<A> {
  /** Inclusive start of the walk, `YYYYMMDD`. */
  fromDay: string;

  /** Inclusive end of the walk, `YYYYMMDD`. */
  toDay: string;

  /** Attribute for a given real day. Not called for filled days. */
  attrFor: (day: string) => A;

  /** True when `day` is a known structural hole — extends but never opens a range. */
  isFilled: (day: string) => boolean;

  /** Structural comparison for two attributes. */
  equal: (a: A, b: A) => boolean;
}

/**
 * Walks `[fromDay, toDay]` day by day and groups them into maximal ranges
 * sharing one attribute. The caller defines what an "attribute" means — for
 * the status grid it's the per-location cell tuple, but the walker itself
 * has no opinion.
 *
 * Rules:
 *   - First real day opens a range. Filled days before any real day are
 *     skipped (they belong to no range).
 *   - A subsequent real day extends the open range when `equal(curAttr, dayAttr)`.
 *     Otherwise the open range closes on the previous real day and a new
 *     range opens on this one.
 *   - Filled days never close, open, or split a range. They sit inside
 *     whatever range is currently open.
 */
export function buildRanges<A>(opts: RangeOptions<A>): Range<A>[] {
  const { fromDay, toDay, attrFor, isFilled, equal } = opts;

  if (fromDay > toDay) return [];

  const ranges: Range<A>[] = [];

  let curStart: string | null = null;
  let curEnd:   string | null = null;
  let curAttr:  A | null      = null;

  for (let d = fromDay; d <= toDay; d = nextDay(d)) {
    if (isFilled(d)) continue;

    const attr = attrFor(d);

    if (curStart === null) {
      curStart = d;
      curEnd   = d;
      curAttr  = attr;
      continue;
    }

    if (equal(curAttr as A, attr)) {
      curEnd = d;
      continue;
    }

    ranges.push({ start: curStart, end: curEnd as string, attr: curAttr as A });
    curStart = d;
    curEnd   = d;
    curAttr  = attr;
  }

  if (curStart !== null) {
    ranges.push({ start: curStart, end: curEnd as string, attr: curAttr as A });
  }

  return ranges;
}
