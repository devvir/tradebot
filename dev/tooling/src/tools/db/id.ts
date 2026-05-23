import { parseMongoId } from '@tradebot/utils';
import { startOfDayMongoId } from '@tradebot/utils';
import { error } from '../../shared/ui/logger';
import { C } from '../../shared/utils/colors';
import { isDateLike, normaliseDate } from './utils/dates';

/**
 * `id` translates between a vault record `_id` and the calendar date it
 * encodes. Numeric inputs ≥ ID_THRESHOLD are treated as ids and decoded;
 * everything else is treated as a (possibly partial) date and encoded to the
 * minimum `_id` for that day.
 *
 * The 53-bit `_id` layout itself lives in `@tradebot/utils` (mongoIds.ts) —
 * this subcommand only owns the date-vs-id disambiguation.
 *
 * ID_THRESHOLD (100 million) cleanly separates the two input spaces: the
 * largest YYYYMMDD value (20991231 ≈ 21M) sits well below it, and the smallest
 * real id (day 1 after epoch = 2^38 ≈ 274 billion) well above.
 */

// ── Exports ──────────────────────────────────────────────────────────────────

const ID_THRESHOLD = 100_000_000;

/** Encode a date string (full or partial ISO / YYYYMMDD) to the minimum _id for that date. */
export function encodeDate(input: string): number {
  return startOfDayMongoId(normaliseDate(input));
}

export function runId(value: string): void {
  const asNumber  = parseInt(value, 10);
  const isNumeric = /^\d+$/.test(value);
  const isId      = isNumeric && asNumber >= ID_THRESHOLD;

  if (isId) {
    if (! Number.isSafeInteger(asNumber)) {
      error(`Value exceeds Number.MAX_SAFE_INTEGER (${Number.MAX_SAFE_INTEGER})`);
      process.exit(1);
    }

    const { date, position, reserved } = parseMongoId(asNumber);

    console.log(`${C.cyan}date${C.reset}      ${C.bold}${date}${C.reset}`);
    console.log(`${C.cyan}position${C.reset}  ${position}`);
    console.log(`${C.cyan}reserved${C.reset}  ${reserved}`);

    return;
  }

  if (isDateLike(value)) {
    const id = encodeDate(value);

    console.log(`${C.cyan}id${C.reset}  ${C.bold}${id}${C.reset}`);

    return;
  }

  error(`Cannot translate '${value}' — expected a vault _id (integer ≥ ${ID_THRESHOLD}) or a date (YYYY, YYYY-MM, YYYY-MM-DD, YYYYMMDD)`);
  process.exit(1);
}

// ── test exports ─────────────────────────────────────────────────────────────

export const _test_ID_THRESHOLD = ID_THRESHOLD;
