/**
 * Deterministic 53-bit safe integer _id for vault-sourced records.
 *
 * Layout: [ date_offset: 14 bits ][ msg_index: 27 bits ][ reserved: 12 bits ]
 *
 *   _id = dateOffset * 2^39 + msgIndex * 2^12 + reserved
 *
 * date_offset — days since 2000-01-01 UTC (fits in 14 bits until ~2044)
 * msg_index   — message position within the day's closed vault file:
 *               - REST tables: row index
 * reserved    — always 0 here; 1–4095 reserved for future gap-fill events
 *
 * Maximum value: (2^14 - 1) * 2^39 + (2^27 - 1) * 2^12 + (2^12 - 1)
 *              = 2^53 - 1 = Number.MAX_SAFE_INTEGER  ✓
 */

const EPOCH_MS  = Date.UTC(2000, 0, 1);
const MS_PER_DAY = 86_400_000;
const SHIFT_39   = 549_755_813_888;  // 2^39
const SHIFT_12   = 4_096;            // 2^12

const parseDateOffset = (date: string): number => {
  const y = parseInt(date.slice(0, 4), 10);
  const m = parseInt(date.slice(4, 6), 10) - 1;
  const d = parseInt(date.slice(6, 8), 10);

  return (Date.UTC(y, m, d) - EPOCH_MS) / MS_PER_DAY;
};

export const makeId = (date: string, msgIndex: number, reserved = 0): number =>
  parseDateOffset(date) * SHIFT_39 + msgIndex * SHIFT_12 + reserved;
