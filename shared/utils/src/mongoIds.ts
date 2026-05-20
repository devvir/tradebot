/**
 * Deterministic 53-bit safe-integer _id for vault-sourced records.
 *
 * Layout:
 *   [ dateOffset: 15 bits ][ slot: 30 bits ][ reserved: 8 bits ]
 *   _id = dateOffset * 2^38 + slot * 2^8 + reserved
 *
 * where slot = position - 1 (position is 1-based; slot 0 = first record of the day).
 *
 * Maximum: (2^15 − 1) * 2^38 + (2^30 − 1) * 2^8 + (2^8 − 1) = 2^53 − 1 = Number.MAX_SAFE_INTEGER
 */

const EPOCH_MS   = Date.UTC(2000, 0, 1);
const MS_PER_DAY = 86_400_000;
const SHIFT_38   = 274_877_906_944;  // 2^38
const SHIFT_8    = 256;              // 2^8

const MAX_DATE_OFFSET = (2 ** 15) - 1;  // 32_767
const MAX_SLOT        = (2 ** 30) - 1;  // 1_073_741_823
const MAX_RESERVED    = (2 ** 8)  - 1;  // 255

// ── Public ────────────────────────────────────────────────────────────────────

/**
 * Build a vault record _id from a date string (YYYYMMDD or YYYY-MM-DD),
 * a 1-based position, and reserved bits. Throws if any component overflows
 * its allocated bit width.
 */
export function makeMongoId(date: string, position: number, reserved: number = 0): number {
  const offset = dateToOffset(date.replace(/-/g, ''));
  const slot   = position - 1;

  if (offset < 0 || offset > MAX_DATE_OFFSET) {
    throw new RangeError(`date '${date}' (offset ${offset}) exceeds 15 bits; valid range 0-${MAX_DATE_OFFSET}`);
  }

  if (slot < 0 || slot > MAX_SLOT) {
    throw new RangeError(`position ${position} exceeds 30 bits; valid range 1-${MAX_SLOT + 1}`);
  }

  if (reserved < 0 || reserved > MAX_RESERVED) {
    throw new RangeError(`reserved ${reserved} exceeds 8 bits; valid range 0-${MAX_RESERVED}`);
  }

  return offset * SHIFT_38 + slot * SHIFT_8 + reserved;
}

/**
 * Decode a vault record _id into its constituent fields.
 * Returns date as YYYY-MM-DD, position as 1-based, reserved as a raw integer.
 */
export function parseMongoId(id: number): { date: string; position: number; reserved: number } {
  const offset    = Math.floor(id / SHIFT_38);
  const remainder = id % SHIFT_38;
  const slot      = Math.floor(remainder / SHIFT_8);
  const reserved  = remainder % SHIFT_8;

  return { date: offsetToIso(offset), position: slot + 1, reserved };
}

/**
 * Minimum _id for all records on a given calendar day.
 * Accepts YYYYMMDD, YYYY-MM-DD, or any ISO timestamp (time component is ignored).
 *
 * Use for MongoDB range queries:
 *   { $gte: startOfDayMongoId(from), $lt: startOfDayMongoId(to) }
 */
export function startOfDayMongoId(date: string): number {
  const d = date.split('T')[0]!.replace(/-/g, '');

  return dateToOffset(d) * SHIFT_38;
}

// ── Internals ─────────────────────────────────────────────────────────────────

function dateToOffset(ymd: string): number {
  const y = parseInt(ymd.slice(0, 4), 10);
  const m = parseInt(ymd.slice(4, 6), 10) - 1;
  const d = parseInt(ymd.slice(6, 8), 10);

  return (Date.UTC(y, m, d) - EPOCH_MS) / MS_PER_DAY;
}

function offsetToIso(offset: number): string {
  return new Date(EPOCH_MS + offset * MS_PER_DAY).toISOString().slice(0, 10);
}
