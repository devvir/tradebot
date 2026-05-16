/**
 * Deterministic _id generation for the generated `instrument` collection.
 *
 * Each message is indexed by day-of-generation + in-day message index. The
 * day component owns the high 39 bits, the message-index the next 12, and
 * bit 0 is reserved (always 1). This makes every _id within a day strictly
 * greater than every _id from prior days, and guarantees start-of-day
 * partials (msgIndex = 0) can be located via `_id % DAY_ID_STRIDE === 1`.
 */

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

/** 2^39 multiplier separating the day-offset portion of `_id` from the in-day index. */
export const DAY_ID_STRIDE = 549_755_813_888;

/** Build an `_id` for a generated message. */
export function makeId(date: string, msgIndex: number): number {
  return dayOffset(date) * DAY_ID_STRIDE + msgIndex * 4096 + 1;
}

/** Convert a day offset back to YYYY-MM-DD. */
export function offsetToDate(offset: number): string {
  const d = new Date(Date.UTC(2000, 0, 1) + offset * 86_400_000);

  return d.toISOString().slice(0, 10);
}

/** Returns the YYYY-MM-DD string for `date + 1 day`. */
export function addDay(date: string): string {
  const d = new Date(date + 'T00:00:00.000Z');

  d.setUTCDate(d.getUTCDate() + 1);

  return d.toISOString().slice(0, 10);
}

/** Truncate a BitMEX timestamp string to millisecond precision. */
export function toMs(ts: string): number {
  return new Date(ts.slice(0, 23) + 'Z').getTime();
}

/* ------------------------------------------------------------------ */
/*  Internals                                                          */
/* ------------------------------------------------------------------ */

/** Days since 2000-01-01 UTC. */
function dayOffset(date: string): number {
  const EPOCH = Date.UTC(2000, 0, 1);
  const d     = Date.UTC(
    parseInt(date.slice(0, 4)),
    parseInt(date.slice(5, 7)) - 1,
    parseInt(date.slice(8, 10)),
  );

  return (d - EPOCH) / 86_400_000;
}
