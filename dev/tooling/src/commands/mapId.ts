import { Command } from 'commander';
import { C } from '../shared/utils/colors';
import { error } from '../shared/ui/logger';

/**
 * Vault record _id layout (53-bit safe integer):
 *   _id = dateOffset * 2^39 + msgIndex * 2^12 + reserved
 *
 *   dateOffset — days since 2000-01-01 UTC (14 bits)
 *   msgIndex   — message position within the day's vault file (27 bits)
 *   reserved   — always 0 for farmer-produced IDs; 1–4095 for gap-fill events (12 bits)
 *
 * Minimum real id (day 1 after epoch, position 0, reserved 0) = 2^39 ≈ 549 billion.
 * Maximum YYYYMMDD date value (20991231) = ~21 million.
 * ID_THRESHOLD (100 million) cleanly separates the two spaces.
 */

const EPOCH_MS     = Date.UTC(2000, 0, 1);
const MS_PER_DAY   = 86_400_000;
const SHIFT_39     = 549_755_813_888;  // 2^39
const SHIFT_12     = 4_096;            // 2^12
const ID_THRESHOLD = 100_000_000;      // numeric values >= this are treated as ids

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

const dateToOffset = (ymd: string): number => {
  const y = parseInt(ymd.slice(0, 4), 10);
  const m = parseInt(ymd.slice(4, 6), 10) - 1;
  const d = parseInt(ymd.slice(6, 8), 10);

  return (Date.UTC(y, m, d) - EPOCH_MS) / MS_PER_DAY;
};

const offsetToIso = (offset: number): string =>
  new Date(EPOCH_MS + offset * MS_PER_DAY).toISOString().slice(0, 10);

/** Encode a date string (full or partial ISO / YYYYMMDD) to the minimum _id for that date. */
export const encodeDate = (input: string): number => {
  const ymd = normaliseDate(input);

  return dateToOffset(ymd) * SHIFT_39;
};

/** Decode a vault _id into its constituent fields. */
export const decodeId = (id: number): { date: string; position: number; reserved: number } => {
  const dateOffset = Math.floor(id / SHIFT_39);
  const remainder  = id % SHIFT_39;
  const position   = Math.floor(remainder / SHIFT_12);
  const reserved   = remainder % SHIFT_12;

  return { date: offsetToIso(dateOffset), position, reserved };
};

/**
 * Register the `map` command.
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
        const asNumber = parseInt(value, 10);
        const isNumeric = /^\d+$/.test(value);
        const isId = isNumeric && asNumber >= ID_THRESHOLD;

        if (isId) {
          if (! Number.isSafeInteger(asNumber)) {
            error(`Value exceeds Number.MAX_SAFE_INTEGER (${Number.MAX_SAFE_INTEGER})`);
            process.exit(1);
          }

          const { date, position, reserved } = decodeId(asNumber);

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
export const _test_dateToOffset  = dateToOffset;
export const _test_offsetToIso   = offsetToIso;
export const _test_ID_THRESHOLD  = ID_THRESHOLD;
