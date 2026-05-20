import { Command } from 'commander';
import { parseMongoId, startOfDayMongoId } from '@tradebot/utils';
import { C } from '../shared/utils/colors';
import { error } from '../shared/ui/logger';

/**
 * `mapId` translates between a vault record `_id` and the calendar date it
 * encodes. Numeric inputs ≥ ID_THRESHOLD are treated as ids and decoded;
 * everything else is treated as a (possibly partial) date and encoded to the
 * minimum `_id` for that day.
 *
 * The 53-bit `_id` layout itself lives in `@tradebot/utils` (mongoIds.ts) —
 * this command only owns the date-vs-id disambiguation.
 *
 * ID_THRESHOLD (100 million) cleanly separates the two input spaces: the
 * largest YYYYMMDD value (20991231 ≈ 21M) sits well below it, and the smallest
 * real id (day 1 after epoch = 2^38 ≈ 274 billion) well above.
 */

const ID_THRESHOLD = 100_000_000;   // numeric values >= this are treated as ids

/** Normalise a partial ISO date string to YYYYMMDD, defaulting month/day to 01. */
const normaliseDate = (input: string): string => {
  const clean = input.replace(/-/g, '');
  const year  = clean.slice(0, 4);
  const month = clean.slice(4, 6) || '01';
  const day   = clean.slice(6, 8) || '01';

  return year + month + day;
};

/**
 * Validate that a value looks like a partial ISO date (with or without dashes).
 * Accepts YYYY, YYYY-MM, YYYY-MM-DD, YYYYMMDD, and their dash-stripped equivalents.
 */
const isDateLike = (value: string): boolean => {
  const clean = value.replace(/-/g, '');

  if (! /^\d+$/.test(clean)) {
    return false;
  }

  if (clean.length !== 4 && clean.length !== 6 && clean.length !== 8) {
    return false;
  }

  if (clean.length >= 6) {
    const month = parseInt(clean.slice(4, 6), 10);
    if (month < 1 || month > 12) return false;
  }

  if (clean.length === 8) {
    const day = parseInt(clean.slice(6, 8), 10);
    if (day < 1 || day > 31) return false;
  }

  return true;
};

/** Encode a date string (full or partial ISO / YYYYMMDD) to the minimum _id for that date. */
export const encodeDate = (input: string): number =>
  startOfDayMongoId(normaliseDate(input));

/**
 * Register the `mapId` command.
 *
 *   tools mapId 2029-01-01          — date/partial ISO → minimum _id for that date
 *   tools mapId 20190901            — YYYYMMDD (numeric but < threshold) → minimum _id
 *   tools mapId 3864783371632640    — _id (numeric >= threshold) → ISO date + position + reserved
 */
export function register(program: Command): void {
  program
    .command('mapId <value>')
    .description('Map between vault record _id and ISO date (numeric ≥ 100M → decode, date → encode)')
    .action((value: string) => {
      try {
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
        } else if (isDateLike(value)) {
          const id = encodeDate(value);

          console.log(`${C.cyan}id${C.reset}  ${C.bold}${id}${C.reset}`);
        } else {
          error(`Cannot translate '${value}' — expected a vault _id (integer ≥ ${ID_THRESHOLD}) or a date (YYYY, YYYY-MM, YYYY-MM-DD, YYYYMMDD)`);
          process.exit(1);
        }
      } catch (err) {
        error((err as Error).message);
        process.exit(1);
      }
    });
}

// ─── test exports ──────────────────────────────────────────────────────────────
export const _test_normaliseDate = normaliseDate;
export const _test_isDateLike    = isDateLike;
export const _test_ID_THRESHOLD  = ID_THRESHOLD;
