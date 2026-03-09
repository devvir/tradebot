/**
 * Computes the minimum _id value for any document written at or after `date`.
 *
 * The writer encodes _id as: Number((BigInt(tsMs) & 0x1FFFFFFFFFFn) << 12n)
 * where tsMs is Unix epoch milliseconds. Documents in [start, end) satisfy:
 *
 *   idBoundary(start) <= _id < idBoundary(end)
 */
export const idBoundary = (date: Date): number =>
  Number((BigInt(date.getTime()) & 0x1FFFFFFFFFFn) << 12n);
