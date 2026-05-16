const EPOCH_MS   = Date.UTC(2000, 0, 1);
const MS_PER_DAY = 86_400_000;
const SHIFT_39   = 549_755_813_888;  // 2^39

/**
 * Returns the minimum _id for all records on the given calendar day.
 * Accepts YYYYMMDD, YYYY-MM-DD, or any ISO timestamp — time and dashes are stripped.
 */
export function startOfDayId(date: string): number {
  const d = date.split('T')[0]!.replace(/-/g, '');

  const offset = (Date.UTC(
    parseInt(d.slice(0, 4), 10),
    parseInt(d.slice(4, 6), 10) - 1,
    parseInt(d.slice(6, 8), 10),
  ) - EPOCH_MS) / MS_PER_DAY;

  return offset * SHIFT_39;
}
