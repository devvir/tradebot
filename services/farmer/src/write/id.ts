/**
 * Deterministic 53-bit safe-integer `_id` for vault-sourced records.
 *
 * Layout (unchanged from legacy):
 *   [ date_offset: 14 bits ][ slot: 27 bits ][ reserved: 12 bits ]
 *   _id = dateOffset * 2^39 + slot * 2^12 + reserved
 *
 * `slot` is the legacy 0-based message index. We take the public
 * `position` (1-based, what the rest of the service uses) and translate
 * to `position - 1` internally so existing mongo `_id`s remain valid and
 * re-processed buckets collide on `E11000` instead of inserting duplicates.
 *
 * Maximum: (2^14 - 1) * 2^39 + (2^27 - 1) * 2^12 + (2^12 - 1)
 *        = 2^53 - 1 = Number.MAX_SAFE_INTEGER  ✓
 */

const EPOCH_MS   = Date.UTC(2000, 0, 1);
const MS_PER_DAY = 86_400_000;
const SHIFT_39   = 549_755_813_888;
const SHIFT_12   = 4_096;

export const makeId = (date: string, position: number, reserved: number = 0): number =>
  dateOffset(date) * SHIFT_39 + (position - 1) * SHIFT_12 + reserved;

const dateOffset = (date: string): number => {
  const y = parseInt(date.slice(0, 4), 10);
  const m = parseInt(date.slice(4, 6), 10) - 1;
  const d = parseInt(date.slice(6, 8), 10);

  return (Date.UTC(y, m, d) - EPOCH_MS) / MS_PER_DAY;
};

// ── Test-only exports ─────────────────────────────────────────────────────────

export const _test_EPOCH_MS   = EPOCH_MS;
export const _test_MS_PER_DAY = MS_PER_DAY;
export const _test_SHIFT_39   = SHIFT_39;
export const _test_SHIFT_12   = SHIFT_12;
